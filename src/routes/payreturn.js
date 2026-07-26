// src/routes/payreturn.js — where a customer's BROWSER lands after paying
// (or cancelling) at Xendit's hosted card page.
//
// No auth here: this is Xendit redirecting the customer's browser mid-payment
// flow, not an authenticated app request, and the customer may not even have
// the app open in the same browser tab (many banking flows happen in a
// separate tab or an in-app browser). It exists purely to be a graceful,
// branded landing spot — a blank 404 here is the last thing a customer sees
// after paying real money, and that is a bad place for it to be blank.
//
// It does NOT update anything. The app polls /payments/:id for the real
// status independently — see Zaini's decision in the buildlog: relying on a
// redirect to drive state is fragile (the customer can close the tab, lose
// signal mid-bank-redirect, or never come back), so this page only informs a
// human, it never mutates a payment.

function page(title, body, tone) {
  const colour = tone === "bad" ? "#EF4D41" : tone === "ok" ? "#0EB57D" : "#0051E9";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Berespro</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,'Segoe UI',Roboto,sans-serif;background:#0B1526;color:#fff;
    min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{max-width:380px;text-align:center;background:#101E36;border-radius:22px;padding:36px 28px}
  .dot{width:56px;height:56px;border-radius:50%;background:${colour};margin:0 auto 18px;
    display:flex;align-items:center;justify-content:center;font-size:26px}
  h1{font-size:19px;margin-bottom:10px}
  p{font-size:14px;line-height:1.6;color:#9FB0CF}
  .hint{margin-top:20px;font-size:12.5px;color:#7C8DA8}
</style></head>
<body><div class="card">
  <div class="dot">${tone === "bad" ? "!" : tone === "ok" ? "\u2713" : "\u21bb"}</div>
  <h1>${title}</h1>
  <p>${body}</p>
  <div class="hint">You can close this window and return to the Berespro app \u2014 it will show the latest status there.</div>
</div></body></html>`;
}

// GET /pay/return?ref=<paymentId>&failed=1
export async function payReturn(req, env) {
  const u = new URL(req.url);
  const failed = u.searchParams.get("failed") === "1";
  const html = failed
    ? page("Payment not completed", "Your payment didn't go through. No money has left your account. You can try again from the task in the Berespro app.", "bad")
    : page("Thanks!", "We're confirming your payment now. This usually takes a few seconds \u2014 the app will show it as soon as it's done.", "ok");
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
