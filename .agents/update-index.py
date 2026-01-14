#!/usr/bin/env python3
"""
Update INDEX.md with all documentation files in .agents folder.
Run from project root: python .agents/update-index.py
"""

import os
import re
from datetime import datetime
from pathlib import Path

AGENTS_DIR = Path(__file__).parent
INDEX_FILE = AGENTS_DIR / "INDEX.md"

# Folders to scan and their emoji/titles
SECTIONS = {
    "docs": ("📖", "Documentation"),
    "bugs": ("🐛", "Bug Reports"),
    "tasks": ("📋", "Tasks"),
    "reports": ("📊", "Reports"),
}

# Subfolders to skip in main listing (shown separately or ignored)
ARCHIVE_FOLDERS = {".archive", ".archived", ".done", ".solved"}


def get_frontmatter(filepath: Path) -> dict:
    """Extract YAML frontmatter from a markdown file."""
    try:
        content = filepath.read_text(encoding="utf-8")
        if content.startswith("---"):
            end = content.find("---", 3)
            if end != -1:
                frontmatter = content[3:end].strip()
                result = {}
                for line in frontmatter.split("\n"):
                    if ":" in line:
                        key, value = line.split(":", 1)
                        result[key.strip()] = value.strip().strip('"').strip("'")
                return result
    except Exception:
        pass
    return {}


def get_title_from_file(filepath: Path) -> str:
    """Get title from frontmatter or first heading."""
    fm = get_frontmatter(filepath)
    if "title" in fm:
        return fm["title"]

    try:
        content = filepath.read_text(encoding="utf-8")
        # Skip frontmatter
        if content.startswith("---"):
            end = content.find("---", 3)
            if end != -1:
                content = content[end + 3:]

        # Find first heading
        for line in content.split("\n"):
            line = line.strip()
            if line.startswith("# "):
                return line[2:].strip()
    except Exception:
        pass

    return filepath.stem.replace("-", " ").replace("_", " ").title()


def get_status(filepath: Path) -> str:
    """Get status from frontmatter."""
    fm = get_frontmatter(filepath)
    return fm.get("status", "")


def scan_folder(folder: Path, base_path: Path) -> list:
    """Scan a folder for markdown files, excluding archive folders."""
    files = []
    if not folder.exists():
        return files

    for item in sorted(folder.iterdir()):
        if item.is_dir():
            if item.name not in ARCHIVE_FOLDERS:
                files.extend(scan_folder(item, base_path))
        elif item.suffix == ".md":
            rel_path = item.relative_to(base_path)
            title = get_title_from_file(item)
            status = get_status(item)
            files.append({
                "path": str(rel_path).replace("\\", "/"),
                "title": title,
                "status": status,
                "name": item.name,
            })

    return files


def format_file_entry(file_info: dict) -> str:
    """Format a file entry for the index."""
    status_badge = ""
    if file_info["status"]:
        status_map = {
            "open": "🟢",
            "in-progress": "🔵",
            "on-hold": "🟡",
            "done": "✅",
            "archived": "📦",
        }
        badge = status_map.get(file_info["status"], "⚪")
        status_badge = f" {badge}"

    return f"- [{file_info['title']}]({file_info['path']}){status_badge}"


def generate_index():
    """Generate the INDEX.md content."""
    lines = [
        "# Documentation Index",
        "",
        "This is the main index for all documentation, bug reports, and task management.",
        "",
    ]

    for folder_name, (emoji, title) in SECTIONS.items():
        folder_path = AGENTS_DIR / folder_name
        files = scan_folder(folder_path, AGENTS_DIR)

        lines.append(f"## {emoji} {title}")
        lines.append("")

        if files:
            for f in files:
                lines.append(format_file_entry(f))
        else:
            lines.append(f"*No {title.lower()} yet.*")

        lines.append("")

    lines.append("---")
    lines.append("")
    lines.append(f"**Last Updated**: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    lines.append("")

    return "\n".join(lines)


def main():
    """Main entry point."""
    content = generate_index()
    INDEX_FILE.write_text(content, encoding="utf-8")
    print(f"✅ Updated {INDEX_FILE}")


if __name__ == "__main__":
    main()
