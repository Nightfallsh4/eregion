# Snapshot provenance

Captured from the active pi setup in `pi-playground` and the user-level Pi
resources. Runtime secrets and state are intentionally excluded.

The repository is structured as an installable pi package rather than a raw
copy of `~/.pi/agent`:

- project workflow agents, workflows, and skills are package resources;
- all extensions are loaded through one package entrypoint;
- global-style extensions are conditionally loaded only when an equivalent is
  not already present;
- skills are contributed conditionally through `resources_discover`, while
  themes are declared as native package resources so the selected theme is
  available during startup.

This layout avoids resource collisions while remaining portable to devices that
do not already have the original global setup.
