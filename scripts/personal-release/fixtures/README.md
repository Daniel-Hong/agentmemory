# Historical administrator-code fixtures

These files are repository source, not operating configuration or user data. They are copied unchanged from Git commit `3d4c00a` for synthetic transition tests. Tests must never load operating root files.

- `pre-transition-enrollment.py.txt`: SHA256 `00e343569903003f0af2f7e06c60b17f4549ee410c85b6c7012f4d14066c672c`, exactly matches the readable installed original enrollment executable.
- `pre-transition-runtime.py.txt`: SHA256 `9b33a051f3106f565626e50ea70e72655bac4710dbea01ad5bc40ade32fff10c`, the historical policy-library epoch. Its runtime triplet identifies the unique public five-candidate group (.7–.11); the administrator diagnostic admits five candidates and excludes .15/.16/.17. That correspondence supports the fixture choice but is not a direct readback of the private installed library bytes.

The synthetic fixture uses these exact old helper/runtime bytes with independently generated temporary policy, catalog, data, packages and receipts. The .15/.16/.17 generated packages remain synthetic. Neither original runtime admission nor private policy is silently changed to make preparation pass.
