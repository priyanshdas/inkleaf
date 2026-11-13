# Inkleaf Privacy Policy

Last updated: 13 November 2026

Short version: Inkleaf doesn't collect anything about you. There's no
account, no tracking, no analytics, no ads and no crash reports sent
anywhere. Your files stay on your devices.

Inkleaf is made by Priyansh Das ("EPD"). This policy covers the desktop app
and the phone apps. It explains what Inkleaf stores on your devices, how
your phone and computer talk to each other, and the few times Inkleaf
connects to the internet.

## What Inkleaf collects

Nothing. I don't run any server that receives your files, your documents'
contents, your usage or any information about you or your computer.

## What stays on your device

To work, Inkleaf keeps these in its own folder on your computer, or in its
own private storage on your phone (and nowhere else):

- your settings, such as theme, auto-save and language;
- a list of recently opened files, with a small picture of each first page;
- backups made before auto-saving over a file, and crash-recovery copies
  of unsaved work;
- fonts, signatures and stamps you add;
- language packs you've downloaded;
- the built-in AI's model (and, on a computer, llama.cpp), if you download
  it; remove it in AI settings;
- your receive code's private key, if you've used Share securely (kept in
  the system's secure storage on a phone);
- API keys for the AI service you choose, if you add any, encrypted with
  your operating system's secure storage;
- on a phone, the PDFs you open, save or receive, in Inkleaf's own library;
- the phones or computer you've paired, with the secret key each pair
  shares (encrypted with the system's secure storage where it has one);
- which files you had open, and on which page, so they can reopen next
  time (switch this off in Settings);
- the scanner you used last, and the settings you chose for each scanner
  (colour, resolution, page size, brightness and contrast).

You can delete any of this by removing a file from the recent list,
clearing the backups folder, removing your API keys in AI settings, or
uninstalling Inkleaf and deleting its folder.

## On your computer

These all happen on your own computer, and none of them sends anything
anywhere:

- **Downloads.** If "Open PDFs as soon as they're downloaded" is on (it is
  unless you switch it off in Settings), Inkleaf watches your Downloads
  folder while it's running and opens new PDFs that arrive there. It only
  notices files ending in .pdf, and only looks at the folder on your own
  computer.
- **Starting when you sign in**, and staying in the tray, are off unless
  you switch them on in Settings. Starting at sign-in adds Inkleaf to your
  system's list of startup apps (on Windows, the same list Task Manager
  shows), and switching it off takes it away again.
- **File Explorer** (Windows): Inkleaf's right-click menu entries, its
  thumbnails of PDFs, and the preview pane all work on the file you're
  looking at, on your computer. The thumbnail maker reads a PDF only when
  File Explorer asks it for a picture, keeps nothing, and has no way to
  connect to the internet.
- **Taskbar and tray:** your recent files appear in the menus of Inkleaf's
  taskbar button and tray icon. They come from Inkleaf's own recent list
  (remove a file there and it goes from both). The taskbar's list also
  follows Windows' own setting for showing recently opened items.

## Scanners and cameras

- **Scanners** connected by USB are reached through their own driver on
  your computer. To find **network scanners**, Inkleaf asks your local
  network (with Bonjour, the way printers announce themselves) when you
  open the scanner; it doesn't go past your own network. Scanned pages go
  straight from the scanner to Inkleaf, and are only saved where you save
  them.
- **Cameras:** Scan to PDF uses your computer's webcam, or your phone's
  camera, only while it's open. The phone app also uses the camera to scan
  a pairing code. Pictures are only kept as the pages you add, and aren't
  sent anywhere.

## Phone and computer link

If you pair a phone with a computer, they send PDFs straight to each other
over your local network (your Wi-Fi). Nothing goes through the internet or
through any server of mine.

- Pairing happens when your phone scans the QR code your computer shows (or
  you paste its code). The code holds the computer's local address and a
  new random secret key, and stops working after ten minutes.
- Every message between the two is encrypted with that key (AES-256-GCM),
  so other devices on the same Wi-Fi can't read or change your files.
- While a phone is paired, the computer listens for it on your local
  network whenever Inkleaf is open. Remove the phone (or the computer, from
  the phone) and the computer stops listening once no devices are paired.
- On the phone, Inkleaf only checks for files from your computer while the
  app is on screen.

## Sharing securely

Share securely locks a copy of a PDF so only the right person can open it.

- **Anyone with the code:** the PDF is locked with standard AES-256 PDF
  encryption, using a long random code that Inkleaf makes and doesn't keep.
- **Only one person's device:** each computer has its own key pair, made the
  first time it's needed. The private key is sealed with your operating
  system's secure storage and never leaves your computer; the public part is
  your "receive code", which is safe to share.
- **Sending with a pickup code:** on the same Wi-Fi, the encrypted file goes
  straight from one computer to the other, and Inkleaf answers on your local
  network only while it's open. Otherwise it goes through the relay described
  below. Scanning the QR code with a phone opens a page on the Inkleaf website
  that downloads and unlocks the file in the browser; the code stays in the
  browser and is never sent anywhere.

## When Inkleaf connects to the internet

Only in these cases, and never with your files unless you ask:

| Feature | What is sent, and to whom | When |
| --- | --- | --- |
| Ask this PDF, AI Summarizer, Translate PDF | With the built-in AI, nothing: it runs on your computer or phone. With a cloud service, the document's text (for Ask this PDF, only the parts that match your question), and your API key, to the AI service you chose in AI settings (Anthropic, OpenAI, Google, xAI, Perplexity or a service you entered). With "AI on this computer", nothing leaves your computer; on a phone, the text goes over your Wi-Fi to the AI app on your own computer | Only when you run one of them |
| Built-in AI download | A download request to GitHub (llama.cpp, computer app only) and to Hugging Face (the model file). Nothing about you or your documents is sent | Only when you press Download in AI settings |
| Web page to PDF | A normal page request to the website you typed | Only when you use it |
| Language packs | A download request to jsDelivr | The first time you use a language that isn't built in |
| Updates | A request to GitHub for the latest version (the computer app, and the Android app when it was installed from the APK; copies from an app store are updated by the store) | When Inkleaf checks for updates, at most once a day |
| Send with a pickup code (Share securely) | The file, encrypted on your computer first, to the Inkleaf relay (a small service run by me on Vercel, source in `relay/`). The key is only in the pickup code, which never goes to the relay, so the relay can't read the file. It's deleted as soon as it's picked up, or after 7 days | Only when you choose to send with a pickup code |
| Receive a File | A request to the Inkleaf relay for the encrypted file, then a request to delete it once it's opened | Only when you receive a file that isn't on your Wi-Fi |
| Links (Ko-fi, GitHub) | Opened in your own web browser | When you click them |

Like any website, these services can see your IP address and basic
request details. What they do with it is covered by their own privacy
policies:

- Anthropic (Claude): https://www.anthropic.com/legal/privacy
- OpenAI (ChatGPT): https://openai.com/policies/privacy-policy
- Google (Gemini): https://policies.google.com/privacy
- xAI (Grok): https://x.ai/legal/privacy-policy
- Perplexity: https://www.perplexity.ai/hub/legal/privacy-policy
- If you use "Other service", that service's own policy applies.
- jsDelivr: https://www.jsdelivr.com/terms/privacy-policy-jsdelivr-net
- GitHub: https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement
- Hugging Face: https://huggingface.co/privacy
- Ko-fi: https://more.ko-fi.com/privacy

Web pages printed with Web page to PDF are loaded in a private session,
without the cookies or logins of your browser or of Inkleaf, and that
session is cleared afterwards.

## Children

Inkleaf collects no personal information from anyone, including children.

## Changes

If this policy changes, the new version ships with a new version of
Inkleaf and the date at the top changes.

## Contact

Questions: open an issue at https://github.com/priyanshdas/inkleaf/issues
