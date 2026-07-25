# Setup

## Run everything inside WSL, on the Linux path

```bash
cd ~/claude-hackathon/Duka-Rafiki   # NOT /mnt/c/... and NOT \\wsl.localhost\...
nvm use                             # reads .nvmrc -> Node 20
npm install
cp .env.example .env                # then fill in the keys
npm run seed                        # loads demo data
npm run dev                         # http://localhost:3000/health -> {"ok":true}
```

## Why this matters (three ways it breaks)

`better-sqlite3` is a native module, and SQLite needs real file locking. That
combination makes this project sensitive to *where* you run it.

1. **Don't `npm install` from Windows against the WSL path.** Windows `node-gyp`
   tries to build in `C:\Windows` and dies with `EPERM`. The UNC path
   (`\\wsl.localhost\...`) is the trigger.
2. **Don't run the app over the UNC path either.** SQLite locking is unreliable
   across the WSL 9p filesystem boundary — you get `SQLITE_BUSY: database is
   locked` on the very first `db.exec()`, even single-process.
3. **Ubuntu's system Node is v18**, too old for some tooling. Use nvm's Node 20
   (`.nvmrc`). Note Windows' Node leaks onto the WSL `PATH`, so `node -v` can
   report a Windows version even after `nvm use` — verify with `which node` if
   something looks wrong.

Native build needs `gcc`, `g++`, `make`, `python3` (already present on Ubuntu
24.04 here).

## Resetting the DB

```bash
rm -f duka.db* && npm run seed
```

`duka.db` is gitignored — never commit it.
