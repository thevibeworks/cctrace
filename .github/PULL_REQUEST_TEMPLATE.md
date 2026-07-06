<!-- One feature per PR. Small diffs review faster. -->

**What & why**
What does this change, and what problem does it solve?

**Checklist**
- [ ] `bun test` passes
- [ ] Added/updated tests for new behavior
- [ ] Updated `CHANGELOG.md` if user-facing behavior changed
- [ ] Redaction path intact (if this touches header/body/URL handling)
- [ ] `isInterceptHost` and the leaf-cert SANs stay in sync (if this touches host routing)
