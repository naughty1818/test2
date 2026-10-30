# SMS payment verification

Atharo-তে hosted checkout নেই। ক্রেতা প্রথমে payment method বেছে configured bKash বা Nagad নম্বরে Send Money করেন। Android ফোনের SMS Forwarder অ্যাপ `POST /api/sms-webhook`-এ JSON পাঠায়; সার্ভার template-based parser দিয়ে শুধু গ্রহণ করা টাকা শনাক্ত করে। ক্রেতার TrxID আর দিতে হয় না: method + নিজের phone + exact order amount + সর্বশেষ ১০ মিনিটের unused SMS মিললেই order automatic paid হয়। একাধিক candidate থাকলে নিরাপত্তার জন্য payment pending থাকে।

## Environment

`SMS_WEBHOOK_API_KEY`, `PAYMENT_RECEIVER_BKASH`, `PAYMENT_RECEIVER_NAGAD`, `SMS_PAYMENT_WINDOW_HOURS` (default 24), `SMS_STALE_MINUTES` (default 30), এবং `SMS_MANUAL_OWNER_ONLY` (default false)। Optional admin pull sync-এর জন্য `SMS_FORWARDER_SYNC_URL` configure করুন; endpoint-কে `{messages:[{sender,body,deviceLabel}]}` JSON দিতে হবে।

## Android SMS Forwarder

Webhook URL: `https://your-domain.example/api/sms-webhook`। POST body: `{ "sender": "bKash", "body": "...", "timestamp": "..." }`; header: `x-api-key`। অ্যাপকে incoming SMS ও background permission দিন। Admin panel-এর **Sync phone SMS** button configured `SMS_FORWARDER_SYNC_URL`-এ ফোন online কিনা check করে এবং returned messages একই parser দিয়ে database-এ নেয়। URL configure না থাকলে button শুধু configuration notice দেখাবে; server নিজে থেকে Android inbox পড়তে পারে না।

## Parser templates

Provider ও message type-এর named capture templates `sms-payments.js`-এর `SMS_TEMPLATES`-এ আছে। bKash received-from-phone, bKash received-deposit এবং Nagad money-received template আছে। Optional `Ref`, extra spaces, line breaks, case differences এবং comma-formatted amounts support করা হয়েছে। আসল format পেলে verified sample `test/fixtures/sms/verified/`-এ রাখুন; unverified mock sample `test/fixtures/sms/unverified/`-এ আছে।

`dd/mm/yyyy hh:mm` তারিখকে Bangladesh time (UTC+6) ধরে UTC-তে সংরক্ষণ করা হয়। Cash In, Cash Out, Send Money, OTP, promotion এবং অচেনা sender কখনো payment transaction হিসেবে save হয় না। Bank deposit sample-এ sender phone না থাকলে তা নিরাপদে ignored হয়, কারণ phone match ছাড়া verify করা যাবে না।

## Troubleshooting

Admin SMS Payments summary-তে last sync, saved transaction, unused/used count এবং pending claim দেখা যায়। Admin manual SMS form-এ provider, sender phone, amount, TrxID ও reason দিয়ে record যোগ করলে pending claim matching চালু হয়। `sms_ingest_log`-এ body ছাড়া `saved`, `duplicate`, `bad_key` ও `parse_failed` outcome রাখা হয়। App request আসছে কিন্তু parse হচ্ছে না হলে sender label, received-money wording এবং Bangladesh local timestamp যাচাই করুন।
