/**
 * Live AI provider check.
 *
 *   npm run ai:check
 *
 * The NVIDIA adapter was written to spec and typechecked, which proves nothing
 * about the wire. This runs it against the real endpoint and reports what is
 * actually true rather than what the docs say should be true.
 *
 * It deliberately does not touch the database, so it runs before seeding or
 * against a throwaway key.
 *
 * What it establishes, in order:
 *   1. the key is accepted and the configured model exists
 *   2. the model emits a real tool call -- the grounding layer depends on this
 *   3. which thinking kwarg this run actually used
 *   4. the real production tool set is accepted
 *
 * Step 3 exists because the kwarg name differs by model family and a wrong one
 * fails silently: the model still answers, it just stops calling tools.
 *
 * The provider is obtained through `resolveProvider()`, the same call the app
 * makes. Constructing the adapter here would test the defaults while reporting
 * whatever was configured, and a check that can disagree with the running app is
 * worse than no check.
 */
import { buildChatTemplateKwargs } from "../src/ai/nvidia";
import { TOOL_SCHEMAS } from "../src/ai/tools";
import { DEFAULT_MODEL, resolveProvider } from "../src/ai/index";
import { ProviderError } from "../src/ai/provider";

let failures = 0;
let warnings = 0;

function ok(label: string, detail?: string) {
  console.log(`  PASS  ${label}${detail ? `  (${detail})` : ""}`);
}
function warn(label: string, detail?: string) {
  warnings++;
  console.log(`  WARN  ${label}${detail ? `  (${detail})` : ""}`);
}
function bad(label: string, detail?: string) {
  failures++;
  console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ""}`);
}
function head(label: string) {
  console.log(`\n${label}`);
  console.log(`  ${"-".repeat(58)}`);
}

/**
 * Sets the exit code rather than calling `process.exit()`.
 *
 * Exiting while undici still holds a keep-alive socket aborts the connection
 * mid-teardown and trips a native assertion on Windows
 * ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"). Letting the process
 * drain is stable.
 */
function finish(code: number) {
  process.exitCode = code;
}

/** A tool call we can verify without a database. */
const PROBE_TOOL = {
  name: "lookup_order",
  description: "Look up an order by its reference.",
  parameters: {
    type: "object",
    properties: { reference: { type: "string", description: "Order reference." } },
    required: ["reference"],
  },
};

const SYSTEM = [
  "You are a shop assistant for a Nigerian retail business.",
  "You must look up an order before saying anything about it.",
  "Never invent an order reference.",
].join(" ");

async function main() {
  console.log("\nAI provider check");

  const { provider, config } = await resolveProvider();

  // Credentials may live in platform settings (set at /admin/platform) as well
  // as in the environment, so the only honest test is asking the resolver.
  if (config.provider !== "nvidia" || config.degraded) {
    console.log(`  ${"-".repeat(58)}\n`);
    if (process.env.AI_PROVIDER?.toLowerCase() === "scripted") {
      console.log("  AI_PROVIDER=scripted, so this check has nothing to test.\n");
      finish(2);
      return;
    }
    console.log("  No NVIDIA API key is configured, so there is nothing to check.\n");
    console.log("  Either:\n");
    console.log("    set it at /admin/platform  (encrypted, takes effect at once)\n");
    console.log("  Or bootstrap from the environment:\n");
    console.log("    Get a free key at https://build.nvidia.com");
    console.log("      1. Sign in");
    console.log("      2. Open any model page");
    console.log('      3. "Get API Key" -> copy the key\n');
    console.log("    then set NVIDIA_API_KEY in .env.local and re-run\n");
    finish(2);
    return;
  }

  console.log(`  model:   ${config.model}`);
  console.log(`  base:    ${process.env.AI_BASE_URL ?? "https://integrate.api.nvidia.com/v1"}`);
  console.log(
    `  key:     ${process.env.NVIDIA_API_KEY ? "from environment" : "from platform settings"}`,
  );
  if (config.model === DEFAULT_MODEL && !process.env.AI_MODEL) {
    warn("using the built-in default model", "set AI_MODEL or save a model at /admin/platform");
  }

  /* ---------------------------------------------------------------- */
  head("1. Key and model");
  const health = await provider.health();
  if (health.ok) {
    ok("key accepted and model is available");
  } else if (/not in \/models/.test(health.detail ?? "")) {
    bad("configured model is not available to this key", health.detail);
    console.log(
      "\n  List every model your key can reach:\n" +
        '    curl -s -H "Authorization: Bearer $NVIDIA_API_KEY" \\\n' +
        "      https://integrate.api.nvidia.com/v1/models\n",
    );
  } else {
    bad("health check failed", health.detail);
    console.log(
      "\n  If /models is not implemented on your deployment that alone does not\n" +
        "  mean the key is bad -- read the tool-call result below.\n",
    );
  }

  /* ---------------------------------------------------------------- */
  head("2. Tool calling (the part everything depends on)");
  let toolWorked = false;

  try {
    const result = await provider.complete({
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: "Where is order ORD-4471? Please check." },
      ],
      tools: [PROBE_TOOL],
      maxTokens: 300,
    });

    if (result.toolCalls.length > 0) {
      const call = result.toolCalls[0];
      toolWorked = true;
      ok("model emitted a tool call", call.name);
      console.log(`        arguments: ${JSON.stringify(call.arguments)}`);

      if (call.name !== PROBE_TOOL.name) {
        warn("called an unexpected tool", call.name);
      } else if (typeof call.arguments.reference !== "string") {
        bad(
          "tool arguments did not match the schema",
          `reference was ${JSON.stringify(call.arguments.reference)}`,
        );
      } else {
        ok("arguments match the declared schema");
      }
    } else {
      bad("model answered in prose instead of calling a tool", result.content.slice(0, 160));
    }

    console.log(
      `        usage: ${result.usage.promptTokens} prompt + ` +
        `${result.usage.completionTokens} completion tokens`,
    );
  } catch (error) {
    const detail =
      error instanceof ProviderError
        ? `${error.message} [${error.kind}${error.retryable ? ", retryable" : ""}]`
        : String(error);
    bad("tool-calling request failed", detail);

    if (error instanceof ProviderError && error.kind === "unauthorized") {
      console.log("\n  The key was rejected. Check NVIDIA_API_KEY.\n");
    }
  }

  /* ---------------------------------------------------------------- */
  head("3. Thinking kwarg");

  const sentFor = process.env.AI_THINKING_PARAM ?? "(default) enable_thinking";
  const effectiveParam = process.env.AI_THINKING_PARAM ?? "enable_thinking";

  // Exactly what goes on the wire, so a failure is diagnosable.
  console.log(`        currently sending: ${sentFor}`);
  console.log(
    `        with tools:    ${JSON.stringify(buildChatTemplateKwargs(effectiveParam, true))}`,
  );
  console.log(
    `        without tools: ${JSON.stringify(buildChatTemplateKwargs(effectiveParam, false))}`,
  );

  if (!toolWorked) {
    warn("could not confirm the kwarg", "tool calling failed above, so this is unproven");
    console.log(
      "\n  This is the failure mode a wrong kwarg causes: the model answers in\n" +
        "  prose instead of calling tools, so nothing looks broken except the\n" +
        "  grounding. Try another name:\n" +
        "\n    AI_THINKING_PARAM=enable_thinking\n" +
        "    AI_THINKING_PARAM=thinking\n" +
        "    AI_THINKING_PARAM=            (send nothing)\n",
    );
  } else if (!effectiveParam) {
    ok("no thinking kwarg is being sent, and tool calling works without it");
  } else {
    ok("the configured kwarg is what this run actually used");
  }

  /* ---------------------------------------------------------------- */
  head("4. Real tool schemas");
  console.log(`  ${TOOL_SCHEMAS.length} production tools are sent on every request.`);
  try {
    const result = await provider.complete({
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: "How much is rice?" },
      ],
      tools: TOOL_SCHEMAS,
      maxTokens: 300,
    });
    if (result.toolCalls.length === 0) {
      warn("model answered without using a production tool", result.content.slice(0, 100));
    } else {
      const name = result.toolCalls[0].name;
      // A model inventing a tool name it was never offered fails at execution
      // time with nothing useful to debug, so it is caught here.
      if (TOOL_SCHEMAS.some((t) => t.name === name)) {
        ok("model called a real production tool", name);
      } else {
        bad("model called a tool that does not exist", name);
      }
    }
  } catch (error) {
    bad(
      "production tool set was rejected",
      error instanceof Error ? error.message : String(error),
    );
  }

  /* ---------------------------------------------------------------- */
  console.log(`\n  ${"-".repeat(58)}`);
  if (failures > 0) {
    console.log(`\n  ${failures} failed, ${warnings} warnings\n`);
    finish(1);
    return;
  }
  if (warnings > 0) {
    console.log(`\n  All checks passed, ${warnings} warning(s).\n`);
  } else {
    console.log("\n  All checks passed. The adapter works against the live API.\n");
  }
  finish(0);
}

main().catch((err) => {
  console.error("\nAI check crashed:", err);
  process.exitCode = 1;
});