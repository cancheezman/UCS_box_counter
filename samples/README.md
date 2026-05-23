# samples/

These files are **synthetic test fixtures**. They contain made-up names,
`@example.com` emails, fake street addresses (per RFC 2606-style examples),
fake phone numbers in the `555-01XX` range (reserved for fictional use),
and fake postal codes. They are not real TOMME customers.

Do NOT replace these files with real customer data. Put real exports in a
local `data/` directory (which is `.gitignore`-d) and pass their paths to
the CLI with `--appstle` / `--orders`.
