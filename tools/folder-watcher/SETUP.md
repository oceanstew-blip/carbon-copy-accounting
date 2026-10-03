# Receipt folder setup (Windows, about 5 minutes)

What it does: you save your CamScanner PDFs (or photos) into one folder. Every 20 seconds the app picks up
anything new, reads it, and files it under Needs Review. Uploaded files move to a Done folder inside it.
Nothing is posted to the books until you review it.

## One-time setup
1. Make a folder called `Receipts` on your Desktop (setup will create it if you skip this).
2. Copy `Watch-Receipts.ps1` into a folder you will not delete, for example `C:\ReceiptWatcher`.
3. Right-click the Start button, choose Windows PowerShell, and run:

       powershell -ExecutionPolicy Bypass -File C:\ReceiptWatcher\Watch-Receipts.ps1 -Setup

4. It asks for the app address, your app username, your app password (hidden as you type), and the folder.
   The password is saved encrypted and only works for your Windows login.
5. It starts right away and restarts every time you log in to Windows.

## Day to day
- One PDF = one receipt, however many pages. Nothing else to do.
- Photos: a loose photo is one receipt. For a long receipt shot as several photos, put all of them in a
  subfolder inside Receipts. A subfolder is always treated as one receipt.
- Check `watcher.log` (next to the script) if something does not show up in the app after a minute or two.
- Anything that fails stays in the folder and is retried.

## In the app
Needs Review lists what came in. Open Review / Fix on a multi-page receipt to see each page.
Tap "Total is on page N" if the amount is wrong, or "Split after page N" if two receipts got joined.

## What the flags in Needs Review mean
- **total disagrees with second read**: the two readers saw different totals. Check the amount against the receipt.
- **total low confidence / total unverified**: the amount might be right but nothing confirmed it. Check it.
- **date looks wrong**: the date is more than about 100 days old or in the future. Check it.
- **more than one receipt detected in this file**: the PDF may hold two receipts. Open it, and use Split if needed.
- **multi-page PDF / photos grouped automatically**: several pages were treated as one receipt. Open Review / Fix to see each page.
  Tap "Total is on page N" if the amount came from the wrong page, or "Split after page N" if two receipts were joined.
Nothing is posted to the books until you review it.

## If something does not show up
1. Wait two minutes, then open `watcher.log` (next to the script) and read the last few lines.
2. "Cannot reach" means the computer has no internet or the app address is wrong. Run setup again with -Setup.
3. A file still sitting in the folder after a few minutes was not uploaded. Anything the app could not read stays there on purpose.

## Upload a whole folder at once
Besides the watched folder, you can point the app at any folder on the computer.
1. Put `Upload-Folder.ps1` and `Upload Folder.bat` in the same folder as `config.json` (the watcher folder).
2. Double-click `Upload Folder.bat`, pick the folder, and answer `y`. Every photo and PDF inside it, including subfolders, goes to the app as its own receipt.
3. The app reads each one and skips duplicates. Nothing on the computer is moved or deleted. A subfolder called `Done` is skipped.
- To list what would be uploaded without uploading: `powershell -File Upload-Folder.ps1 -Path "C:\Receipts\August" -DryRun`
- Results are also written to `Upload-Folder.log`.
- It uses the same app address and login as the watcher. If it says the login is wrong (401), run the watcher setup again.
- A PDF or photo that holds several receipts is still read as ONE receipt. Split it first (see "What the flags mean").
