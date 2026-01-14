# AGENTS.md

Guidelines for AI agents working on this project.

## Documentation Workflow

This project uses a `.agents/` folder to organize AI-generated documentation, tasks, bugs, and reports.

### Folder Structure

```
.agents/
├── INDEX.md          # Auto-generated index of all documentation
├── AGENTS.md         # This file - agent guidelines
├── docs/             # Feature documentation
│   ├── features/     # Feature-specific docs
│   └── .archive/     # Archived documentation
├── tasks/            # Implementation tasks
│   ├── .done/        # Completed tasks
│   └── .archived/    # Obsolete/cancelled tasks
├── bugs/             # Bug reports
│   ├── .solved/      # Fixed bugs
│   └── .archived/    # Invalid/duplicate bugs
└── reports/          # Audits, research, analyses
    ├── .done/        # Completed reports
    └── .archived/    # Outdated reports
```

### File Naming Conventions

- **General**: Use kebab-case: `feature-name.md`
- **Reports**: Include date: `security-audit_2025-01-15.md`
- **Numbered ordering**: Prefix with numbers: `01-setup.md`, `02-config.md`

### Status System

All documents use YAML frontmatter with these statuses:
- `open`: Ready to work on (default for new tasks/bugs)
- `in-progress`: Currently being implemented
- `on-hold`: Blocked or paused
- `done`: Completed
- `archived`: No longer relevant

### Creating Documents

Use the **docs-manager** skill for consistent templates:
- Bug reports → `.agents/bugs/`
- Tasks → `.agents/tasks/`
- Documentation → `.agents/docs/features/`
- Reports/Audits → `.agents/reports/`

### Updating the Index

After creating, moving, or deleting files, run the index update script to regenerate INDEX.md:

```bash
python .agents/update-index.py
```

### Before Starting Work

1. Check `INDEX.md` for existing documentation
2. Review related tasks in `.agents/tasks/`
3. Check for similar bugs in `.agents/bugs/`
4. Look for relevant reports in `.agents/reports/`

### After Completing Work

1. Update task/bug status to `done`
2. Move completed items to `.done/` or `.solved/` folders
3. Run the index update script
4. Create documentation for significant changes
