# Crew & Plant Roster

Scheduling board for crews, staff, machines and the asphalt plant, with jobs, shift quantities, Excel exports and a forecast.

- `index.html` + `app.js`: the app (no build step)
- `api/config.js`: gives the app the Supabase address and public key from Vercel's settings
- `supabase/schema.sql`: database tables, sign-in roles and security rules

## Set up (once)

### 1. Database (Supabase)
1. Supabase → your project → **SQL Editor** → **New query**. Paste all of `supabase/schema.sql` and click **Run**.
2. **Authentication → Sign In / Providers**: make sure **Email** is on, and turn **off** "Allow new users to sign up" so only people you invite can get in.
3. Note two values from **Project Settings → API**: the **Project URL** and the **anon public** key. Never use the `service_role` key in the app.

### 2. Website (Vercel)
1. Vercel → **Add New → Project** → import the `AFA` GitHub repository.
2. Framework preset: **Other**. Leave the build and output settings empty.
3. **Environment Variables**: add
   - `SUPABASE_URL` = the Project URL
   - `SUPABASE_ANON_KEY` = the anon public key
4. **Deploy**. Note the address Vercel gives you (e.g. `https://afa.vercel.app`).

### 3. Connect the two
1. Supabase → **Authentication → URL Configuration**: set **Site URL** to the Vercel address, and add it under **Redirect URLs** too. Do the same later for your own domain.
2. Supabase → **Authentication → Users → Invite user**: invite yourself, then open the roster and sign in with that email.
3. Make yourself the administrator: **SQL Editor** →
   ```sql
   update public.profiles set role = 'admin' where email = 'you@yourcompany.com.au';
   ```
4. Reload the roster. The first time, it asks whether to start empty or with sample data.

### Adding people
Invite each person from **Authentication → Users → Invite user**. They start as **viewers** (can look, not change). To let someone edit, set their role to `planner` in **Table Editor → profiles**, or:
```sql
update public.profiles set role = 'planner' where email = 'name@yourcompany.com.au';
```

### Your own web address
Vercel → Project → **Settings → Domains** → add e.g. `roster.yourcompany.com.au` and follow the DNS instructions. Then add the new address to Supabase's URL Configuration (step 3.1).

### Sign-in emails
Supabase's built-in email sender only allows a few emails an hour. Before rolling out to the whole team, set up your own email sender under **Project Settings → Authentication → SMTP Settings**.

## What is shared and what is personal
Shared by everyone: crews, staff, machines, asphalt plants, jobs, bookings, quantities, mixes, binders and quote-change history.
Personal to each person's browser: hidden rows, section order, view length, dark mode and notification settings.
