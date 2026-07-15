# Berespro — Operating Entity: Astaka Mega Sdn Bhd

Berespro operates as a product/brand under **Astaka Mega Sdn Bhd**. This note records
what that means operationally and legally, and what still needs to be done.

## What this means
- **Operator of record:** Astaka Mega Sdn Bhd. All Berespro Terms, Privacy, and
  Refund policies name Astaka Mega as the operator/data user.
- **PSP merchant account:** opened in Astaka Mega's name (SSM cert + company bank
  account + director KYC). Partner payouts flow as sub-merchants under this account.
- **Money flow:** platform commission (the 20%) settles to Astaka Mega's company
  bank account. Customer funds are held by the PSP, never by Astaka Mega directly.
- **Liability:** disputes, chargebacks, and regulatory obligations attach to
  Astaka Mega Sdn Bhd.

## Action checklist (outside the code)
- [ ] Fill the real SSM registration number into all three legal docs (search
      "[SSM No. — isi nombor pendaftaran Astaka Mega]")
- [ ] Confirm Astaka Mega's **business activity codes / MSIC** with SSM cover
      "online intermediation / marketplace platform services" — a construction
      company's registered scope may not include operating a digital marketplace.
      Add/expand the MSIC code if needed (cheap, done via SSM). **Ask a company
      secretary.** This matters because the PSP and (later) auditors check that
      your registered activities match what you actually do.
- [ ] Company bank account ready to receive PSP settlements
- [ ] Decide bookkeeping: run Berespro revenue as a clear cost/revenue centre
      inside Astaka Mega's accounts so it can be separated later if you spin it out
- [ ] Have a lawyer review the three policy docs with Astaka Mega named as operator
- [ ] SST/tax: check whether the 20% platform fee is a taxable service under SST
      (service tax) at your revenue level — accountant question, not a code question

## If you spin Berespro out later
Keeping Berespro's revenue/costs as a clean internal centre now makes a future
transfer to a dedicated "Berespro Sdn Bhd" much easier (asset/IP assignment,
novating the PSP account, migrating merchant records). Nothing in the API is tied
to the entity name except the legal docs and the PSP account — the code is portable.

## Two honest flags
1. **A construction company operating a payments-carrying consumer marketplace** is
   a real change of business character. It's fine and common, but confirm the MSIC
   scope (above) and tell your company secretary/auditor — don't let it surprise
   them at year-end.
2. **The MOF certificate is irrelevant to this.** It's for government procurement,
   not payment gateways or marketplace operation. Don't rely on it for PSP onboarding.
