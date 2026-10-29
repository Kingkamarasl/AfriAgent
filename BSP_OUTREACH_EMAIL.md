# BSP outreach: the email, and how to read the answers

The WhatsApp numbering question has been open long enough that the code no
longer depends on it — `whatsapp_links.mode` holds either answer. What is still
blocked is the *decision*, and it cannot be made from public documentation.

This is the email that unblocks it. Send it to three BSPs.

---

## The email

**Subject:** Question about onboarding non-registered SMBs to WhatsApp Business Platform

Hi,

I'm building an AI assistant for small retail shops in Nigeria — owner-operated
businesses, typically one to five people, that currently use WhatsApp Business
App by hand. It answers customer questions, chases invoices, and sends daily
summaries, all over WhatsApp, and asks the owner before anything goes out.

I'm at the point of choosing how shops connect their numbers, and I'd rather
not guess. Two things I can't find a definitive answer to in Meta's public docs:

**1. Verification requirements under a verified portfolio.**
If my Business Portfolio is verified and a WhatsApp Business Account under it
has an approved display name, can that WABA carry useful messaging limits
without the sub-business itself being individually verified? In practice most of
my target shops have no website, no domain email, and possibly no incorporation
certificate — so per-shop verification looks like it would rule out the segment
I'm building for.

**2. Partner-led verification.**
Meta documents a partner-led path that removes the website requirement, but it
appears gated behind Select/Premier Solution Partner status. Does [BSP name]
hold that status? If so, what does onboarding a sub-business look like through
you, and what does it cost?

**3. Commercial model.**
Per-message pricing, platform fee, any cut of the messaging revenue, minimum
commitments, and whether pricing differs for a platform serving many small
businesses versus a single business.

If it's easier, a 20-minute call would work — but I'd genuinely prefer written
answers I can circulate internally.

Thanks,
[Name]
[Company] — [site]

---

## What good answers look like

**The one that matters most is question 1.** It collapses the whole decision:

- *"Yes, a verified portfolio is enough"* → platform-provisioned numbers become
  clearly viable, and per-shop onboarding stops being a blocker.
- *"Each business must be verified"* → per-shop onboarding is impractical for
  this market and you are in the platform-provisioned model regardless. Also a
  useful thing to know before you build anything else.

Treat a vague answer as a no. If they can't tell you whether sub-business
verification is required, they haven't done it at your scale.

**Question 2** is the other real unlock. If they hold Select status, shops
without a website can be onboarded at all — that is the difference between a
segment you can serve and one you can't.

**Question 3** tells you whether this is a viable business. A BSP taking a large
cut of per-message revenue against a subscription-plus-overage model may erase
your margin. Do that arithmetic before committing.

## Before you send

- **Don't name a specific BSP yet** — you're comparing three.
- **Don't ask for a demo first.** You want written answers you can circulate,
  and a sales call is how you end up on a call instead of an email thread.
- **Send to Nigeria/Africa-regioned BSPs.** Pricing and sub-business onboarding
  differ by region, and a US BSP's answer may not reflect your market.

## What to do while you wait

Run Embedded Signup **by hand for five shops**. Do not automate it yet.

You want three numbers, and they are only obtainable by actually doing it:

1. What fraction of shops clear verification unaided?
2. How many days from start to a number that can receive messages?
3. Where does a shop owner give up?

Those numbers are worth more than either implementation, and a fortnight of
manual work produces them without writing a line of provisioning code.

Whatever the answers say, the pilot should not use production numbers yet —
the simulator and the manual path cover it, and burning Meta's review process on
a five-shop pilot buys nothing.