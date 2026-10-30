# Live-run runbook

For the D&A session that loads the 2026 files and builds the schedule, and for the days after it until the show. Written for whoever is at the keyboard, D&A or Olive. Button names are the ones on screen.

## Before the session

- Every admin can sign in. Anyone who turned on two-factor sign-in has their authenticator app and their backup codes with them.
- The files are final versions: participants, suppliers, buyer hotel rankings, buyer biztech rankings, supplier rankings. Keep the originals; the app stores a copy of each upload.
- Settings on the event match the show: date, timezone, slot count and times, meetings per supplier, buyer minimum, ideal, and maximum, thresholds, biztech rule. Change these before matching; after the lock they are read-only.
- Optional: branding (logo and colors) on the Settings page. It can be changed later, even after the lock.

## Loading the files

Load the roster files first, then the ranking files. A ranking file that names someone not on the roster yet waits under "Needs mapping" and checks itself again when the roster file that has them is applied.

1. Imports, Participants card: upload, read the report, Apply import.
2. Suppliers card: the same.
3. The three ranking cards: upload each, read the report.
   - Unknown names: map them only when you are sure who the file means. "Save all suggested" takes only near-certain matches and says how many it skipped; map the rest one by one.
   - If an unknown name is a person or hotel that should be on the roster, add them (or load the roster file that has them) instead of mapping them to someone else.
   - A saved name mapping is listed under saved names on the Imports page. If one is wrong, Remove it; the waiting files are checked again.
   - Read the warnings, especially "lists X more than once" and "clears their organization or title".
4. Apply each ranking file. Imports, readiness shows when matching can run.

A wrong file on a card is refused with a message saying which card it belongs on. A file with the template's example row still in it is refused too: delete the row and upload again.

## Matching and review

1. Matching: Run matching. Read the counts and warnings.
2. Schedule: check the Quality view first (people above or below their targets), then the Supplier desks and Buyers views.
3. Fix by hand in Edit schedule: Replace, Remove, Add, Pin. Every change is in Activity and can be undone there.
4. Changed a setting or a ranking file? Run matching again for a fresh schedule, or "Re-run and keep existing appointments" to keep what you edited and fill only the gaps.
5. Lock schedule. Desks are assigned and every participant and supplier contact gets a private link.

## Sending

1. Exports: download the master CSV, the schedules ZIP, the quality report, and the access list (every link, in case email fails).
2. Emails: New campaign. Check the sender, reply-to, subject, and body; use Preview as on two or three people; Send test to yourself and open the link on a phone.
3. Send to everyone. The delivery table fills in as Resend reports; use Refresh status.
4. Bounced or failed: fix the address on the Participants or Suppliers page, then Retry delivery. Changing someone's email replaces their link, so the old one stops working.

## Late changes (after sending)

1. Schedule: Unlock schedule (a reason is required).
2. Withdraw the person on Participants or Suppliers. Their past meetings and rankings stay; they are left out of matching.
3. Fix the schedule by hand, or "Re-run and keep existing appointments".
4. Lock schedule again.
5. Emails: Draft update. It goes only to people whose schedule changed since their last email.

## When something goes wrong

| Problem | What to do |
|---|---|
| Wrong ranking file applied | Imports history: delete that import (its rankings go with it), then upload the right file. |
| Wrong roster file applied | Deleting the import does not remove people. Upload and apply the right file (it updates people by email or supplier name), then withdraw anyone who should not be there. |
| Wrong name mapping saved | Imports, saved names: Remove it. |
| Someone lost their schedule link | Participants or Suppliers: Regenerate link, then send them the new link (an update email or the access list). |
| A link was shared by mistake | Revoke link, then Regenerate link for the right person. |
| An admin forgot their password | Forgot password on the sign-in page. The link works for one hour. |
| An admin lost their authenticator and backup codes | Olive runs `pnpm reset-two-factor <email>` against production. It signs them out everywhere and is logged. |
| An admin is locked out after wrong passwords | Wait 10 minutes. |
| Emails are not arriving at all | Check the Resend dashboard for the sending domain, then email the access list links as a fallback. |
| The site is down or a deploy broke it | Olive: Vercel, Deployments, instant rollback to the previous deployment. Data mistakes: Neon point-in-time restore. |
| Anything else | Olive support. Note the event, the page, and the time; Activity shows who changed what. |
