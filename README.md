# Crew & Plant Roster

Scheduling board for crews, staff, machines and the asphalt plant, with jobs, shift quantities, Excel exports and a forecast.

- `index.html` + `app.js`: the app (no build step)
- `api/config.js`: gives the app the Supabase address and public key from Vercel's settings
- `supabase/schema.sql`: database tables, sign-in roles and security rules

## Set up (once)

### 1. Database (Supabase)
1. Supabase → your project → **SQL Editor** → **New query**. Paste all of `supabase/schema.sql` and click **Run**.
2. **Authentication → Sign In / Providers**: make sure **Email** is on, and turn **off** "Allow new users to sign up" so only people you add can get in.
3. Note two values from **Project Settings → API**: the **Project URL** and the **anon public** key. Never use the `service_role` key in the app.

### 2. Website (Vercel)
1. Vercel → **Add New → Project** → import the `AFA` GitHub repository.
2. Framework preset: **Other**. Leave the build and output settings empty.
3. **Environment Variables**: add
   - `SUPABASE_URL` = the Project URL
   - `SUPABASE_ANON_KEY` = the anon public key
4. **Deploy**. Note the address Vercel gives you (e.g. `https://afa.vercel.app`).

### 3. Connect the two
1. Supabase → **Authentication → URL Configuration**: set **Site URL** to the Vercel address. Do the same later for your own domain.
2. Create your own account: **Authentication → Users → Add user → Create new user**. Enter your email and a temporary password, tick **Auto Confirm User**, and click **Create user**.
3. Make yourself the administrator: **SQL Editor** →
   ```sql
   update public.profiles set role = 'admin' where email = 'you@yourcompany.com.au';
   ```
4. Open the roster and sign in with your email and the temporary password. It asks you to choose your own password, then to start the roster.

### Adding people
1. **Authentication → Users → Add user → Create new user**: their email, a temporary password, tick **Auto Confirm User**.
2. Give them the temporary password. When they first sign in, they choose their own.
3. They start as **viewers** (can look, not change). To let someone edit, set their role to `planner` in **Table Editor → profiles**, or:
   ```sql
   update public.profiles set role = 'planner' where email = 'name@yourcompany.com.au';
   ```

### Resetting a forgotten password
In **SQL Editor**, give them a new temporary password. They choose their own again when they next sign in:
```sql
update auth.users
set encrypted_password = extensions.crypt('Temporary-Pass-123', extensions.gen_salt('bf')),
    raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) - 'password_set',
    email_confirmed_at = coalesce(email_confirmed_at, now())
where email = 'name@yourcompany.com.au';
```
Anyone signed in can change their own password with the key button at the top of the roster.

### Your own web address
Vercel → Project → **Settings → Domains** → add e.g. `roster.yourcompany.com.au` and follow the DNS instructions. Then add the new address to Supabase's URL Configuration (step 3.1).

## Install it as an app
FraserFlow can be installed on phones and computers and then opens from its own icon, full screen.
- **iPhone / iPad:** open the site in Safari → Share → **Add to Home Screen**.
- **Android:** open it in Chrome → **Install app** (or the menu → *Add to Home screen*). The Prestarts screen offers an *Install* button.
- **Computer (Chrome / Edge):** the install icon in the address bar, or Settings (top right) → *Install FraserFlow as an app*.

It always runs the latest version: there is nothing to update. On iPhones the installed app keeps its own sign-in, so people sign in once more after adding it.
Files: `manifest.json`, `sw.js` (service worker), `icons/`.

## What is shared and what is personal
Shared by everyone: crews, staff, machines, asphalt plants, jobs, bookings, quantities, mixes, binders and quote-change history.
Personal to each person's browser: hidden rows, section order, view length, dark mode and notification settings.

## Fleet & Maintenance

Servicing, meter readings, work orders and breakdowns for the machines on the roster (the **Fleet** screen), and digital prestart checks done on a phone (the **Prestarts** screen).

- `maint.js`: the Fleet screens, loaded only when someone opens Fleet or Prestarts
- `prestart.js`: the Prestarts screen, the checklist builder, prestart history, logins, and machine manuals
- `defects.js`: the defect register, defect actions, restrictions and return to service
- `reports.js`: Fleet reports (CSV and PDF) and each machine's history PDF
- `supabase/maintenance.sql`: the maintenance tables, roles and database rules
- `supabase/prestarts.sql`: prestart checklists and prestarts, the `maintenance` file store, and the link from each login to its Staff record
- `supabase/defects.sql`: defects, restrictions, and how work orders carry defects through repair
- `supabase/planner_link.sql`: stops restricted machines being added to bookings or plans; `machine_alerts` for the planner's warnings; `maintenance_feed` for the notifications bell
- `tests/maintenance_test.sql`, `tests/prestarts_test.sql`, `tests/defects_test.sql`, `tests/planner_link_test.sql`: check the database rules; they leave no data behind

### Set up (once)
1. Supabase → **SQL Editor** → **New query**. Paste all of `supabase/maintenance.sql` and click **Run**. It is safe to run again and doesn't change roster data.
2. Do the same with `supabase/prestarts.sql` (after `maintenance.sql`). It also creates the private file store (Storage bucket `maintenance`) for prestart photos, signatures and manuals.
3. Then `supabase/defects.sql` (after `prestarts.sql`), then `supabase/planner_link.sql` (run it again after updates: it adds the notification feed).
4. To check them: paste `tests/maintenance_test.sql` into a new query and **Run**, then `tests/prestarts_test.sql`, `tests/defects_test.sql` and `tests/planner_link_test.sql`. The messages list each check as PASS and finish with `ALL … TESTS PASSED`. They roll themselves back.

### Roles
| Role | Schedule | Maintenance |
| --- | --- | --- |
| `admin` | Everything | Everything: service plans, verify & close, meter corrections. Also sees features still in progress |
| `superuser` | Everything | Everything an admin can do, except features the admin hasn't released yet |
| `planner` | Edit | View |
| `supervisor` | View | Record work, verify & close work orders |
| `mechanic` | View | Record services, readings and work order progress |
| `prestart` | Prestarts only (once Prestarts is released; until then, View) | Prestarts |
| `viewer` | View | None |

**Ideas** is for the `admin` only, never superusers.

### Prestarts
- **Checklists** (Fleet › Checklists, admin and superuser): one per machine category, plus an optional one for *all other machines*. Start from the standard list and change it. Saving a change makes a new version; prestarts already done keep the questions they answered. Mark questions **critical**: a fail means *Do not operate*.
- **Operators** fill in the prestart on their phone: meters, each question (Pass / Fail / N/A; a fail needs a comment and can have photos), signature and declaration. Answers are saved on the phone as they go, so a dropped connection or a closed browser loses nothing. Submitting twice never makes two prestarts.
- A submitted prestart can't be changed. Only the `admin` can delete one (e.g. a test): open it → *Delete…*, give a reason. A full copy and the reason are kept in the audit trail. Hours or km lower than the last reading don't stop the prestart: it is saved with a note and the reading isn't recorded.
- **Logins** (Staff › People, admin and superuser): set each person's role and link each login to its Staff record, so prestarts carry the operator's name. Nobody can change their own role, and only the `admin` can give or remove the admin role. New logins are still added in Supabase → Authentication → Users.

### Defects
- A failed prestart item becomes a **defect** (major, or critical for a critical question). While it is open, the same item failing again adds to it ("seen 3×") instead of making a new one. Maintenance staff can also report defects by hand from the machine panel.
- A **critical** defect **restricts** the machine: *do not use*. It shows as out of service in Fleet and *Do not use* on operators' phones. A later passing prestart never clears it.
- Repair: **Raise work order** on a defect (several defects can go on one work order). Completing the work order marks its defects repaired; a supervisor or administrator verifying it closes them. Small fixes can be marked *Fixed on the spot*, then verified.
- **Return to service**: only an administrator, and only once the repair is verified (defect closed or dismissed), from the machine panel. Administrators can also take a machine out of service by hand.
- Supervisors and administrators can **dismiss** a defect with a reason (not a fault, duplicate). Defects are never deleted.

### In the planner
- A **restricted** machine can't be ticked on a booking's Machines tab or in a plan's *Machines needed*, and the database refuses it from any route (copies, plan pushes, imports).
- Bookings that already had it keep it, but are flagged: a red ⚠ on the booking bar (today onwards), a warning when the booking opens, ⚠ on the Machines tab. A plan with a newly added restricted machine can't be sent to the schedule.
- Machine pickers also warn (without blocking) when a machine's **service is overdue or due soon**, or it has **open defects**. The Machines screen marks restricted machines.

### Reports
Fleet › **Reports**: work order backlog, service compliance, prestart compliance (prestarts on the days each machine was booked), downtime, breakdowns, defects and service history. Pick the dates and category; export each to **CSV** (Excel) or a branded **PDF**. Each machine's panel has a **History PDF**.

### Notifications
The bell gets maintenance notifications for people with Fleet & Maintenance: critical defects and restrictions, restricted machines on bookings, breakdowns, returns to service, prestarts missing by 9 am (9 pm for night works), work orders, and services due. All start off: each person switches on the ones they want in Settings (top right). **Open** goes to the machine in Fleet, or to the booking.

### Working without reception
Once FraserFlow has been opened on a phone with reception, it opens again without reception from the copy saved on that phone (a bar at the top says so; nothing can be changed except prestarts). Prestarts, their photos and signature are saved on the phone and **send themselves** when reception returns (or *Send now*), never twice. Anything the server refuses stays listed under *Waiting to send* with the reason.

**Features in progress:** Fleet & Maintenance and Prestarts start out visible to the `admin` only (marked *Preview* in the left menu). Release each one from the settings menu (top right) under *Features in progress*.

After pulling this version, run `supabase/schema.sql`, then `supabase/maintenance.sql`, `supabase/prestarts.sql`, `supabase/defects.sql` and `supabase/planner_link.sql` in the SQL Editor: all are safe to re-run.

### Staff
The **Staff** screen has two views (switch at the top):
- **Leave calendar**: everyone's leave, sick days, RDOs and training, on the same calendar as before and counted as *staff away* on the schedule. The **Leave** panel beside it lists who's away today and over the next 4 weeks; **Add leave** books it, and clicking any leave changes or removes it.
- **People**: the staff list with crew, position and current or next leave. Planners and administrators add, edit and remove staff here (it is no longer under Settings). Administrators and superusers also see each person's **login** on their row (username, role, *Create login*, *Reset password*), and a list of logins that aren't linked to anyone on staff.

### Creating logins inside FraserFlow
Staff › **People**: *Create login* on a person's row, or **New login** under *Logins without a staff member* (administrators and superusers): username (or email), a temporary password (one is suggested), role and Staff record. **Reset password…** on a row gives someone a new temporary password. Either way they choose their own the next time they sign in. Only the administrator can create admins or reset an admin's password; nobody resets their own here.

This needs one setting, because creating logins uses Supabase's admin key, which must stay on the server:
1. Supabase → **Project Settings → API Keys** (or *API*) → copy the **service_role** secret key. Never paste it anywhere else, or into a chat.
2. Vercel → Project → **Settings → Environment Variables** → add `SUPABASE_SERVICE_ROLE_KEY` with that value (Production).
3. Vercel → **Deployments** → redeploy the latest.

The key is only used by `api/users.js`, which checks that the person asking is signed in as an administrator or superuser. `tests/api_users_test.js` checks those rules (`node tests/api_users_test.js`).

The **prestart** role was called `operator` before. Running `supabase/schema.sql` (or `maintenance.sql`) again renames it for everyone who had it; until then the app treats both names the same.

### Usernames instead of email addresses
People can sign in with a plain username (e.g. `jsmith`) instead of an email. Supabase still needs an address for every login, so a username is stored as `jsmith@fraserflow.local` (nothing is ever sent there); FraserFlow only ever shows `jsmith`.
To add one: Staff › People › **Create login**, or in Supabase → **Authentication → Users → Add user → Create new user**. Email: `jsmith@fraserflow.local`, a temporary password, tick **Auto Confirm User**. They sign in with `jsmith` and the temporary password, then choose their own. Forgotten passwords: reset it the same way (a new temporary password). People with real email logins keep signing in with their email.

Set a role the same way as before, e.g. `update public.profiles set role = 'mechanic' where email = 'name@yourcompany.com.au';`
