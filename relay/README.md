# Inkleaf relay

Holds files sent with an Inkleaf pickup code until they're picked up, for
people who aren't on the same Wi-Fi. It runs on Vercel, with Vercel Blob for
storage.

It never sees anything readable. Inkleaf encrypts each file (AES-256-GCM)
with a key that exists only in the pickup code, before uploading it. The
relay only:

- gives out a one-time token to upload one file (15 minutes, one exact path,
  100 MB at most),
- says where to download it from,
- deletes it when someone who has the code asks (they prove it with a delete
  token derived from the code),
- deletes anything older than 7 days, once a day.

There are no accounts, and it stores nothing except the encrypted files.

## Deploying your own

1. Create a Vercel project with this folder as its root, and connect a Blob
   store to it (that sets `BLOB_READ_WRITE_TOKEN`). Optionally set
   `CRON_SECRET`.
2. Point Inkleaf at it: change `DEFAULT_RELAY` in `src/main/pickup.ts` and
   `RELAY` in `website/get/index.html`.
