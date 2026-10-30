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

## What is shared and what is personal
Shared by everyone: crews, staff, machines, asphalt plants, jobs, bookings, quantities, mixes, binders and quote-change history.
Personal to each person's browser: hidden rows, section order, view length, dark mode and notification settings.

## Fleet & Maintenance

Servicing, meter readings, work orders and breakdowns for the machines on the roster (the **Fleet** screen).

- `maint.js`: the Fleet screens, loaded only when someone opens Fleet
- `supabase/maintenance.sql`: the maintenance tables, roles and database rules
- `tests/maintenance_test.sql`: checks the database rules; leaves no data behind

### Set up (once)
1. Supabase → **SQL Editor** → **New query**. Paste all of `supabase/maintenance.sql` and click **Run**. It is safe to run again and doesn't change roster data.
2. To check it: paste `tests/maintenance_test.sql` into a new query and **Run**. The messages list each check as PASS and finish with `ALL MAINTENANCE TESTS PASSED`. It rolls itself back.

### Roles
| Role | Schedule | Maintenance |
| --- | --- | --- |
| `admin` | Everything | Everything: service plans, verify & close, meter corrections. Also sees features still in progress |
| `superuser` | Everything | Everything an admin can do, except features the admin hasn't released yet |
| `planner` | Edit | View |
| `supervisor` | View | Record work, verify & close work orders |
| `mechanic` | View | Record services, readings and work order progress |
| `operator` | View | Prestarts (coming next) |
| `viewer` | View | None |

**Features in progress:** Fleet & Maintenance and Ideas start out visible to the `admin` only (marked *Preview* in the left menu). Release each one from the settings menu (top right) under *Features in progress*.

After pulling this version, run `supabase/schema.sql` and then `supabase/maintenance.sql` again in the SQL Editor: both are safe to re-run and add the new roles.

Set a role the same way as before, e.g. `update public.profiles set role = 'mechanic' where email = 'name@yourcompany.com.au';`
