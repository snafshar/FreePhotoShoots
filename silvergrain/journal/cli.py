"""Owner-only commands run in the application's server environment."""

import argparse
from getpass import getpass
from pathlib import Path
import os
import re

from dotenv import load_dotenv

from .security import hash_password
from .store import connect, initialize

load_dotenv()


def main():
    parser = argparse.ArgumentParser(prog="python -m journal.cli")
    parser.add_argument("command", choices=("set-admin", "remove-samples"))
    parser.add_argument("--username", default="admin", help="Username for set-admin")
    args = parser.parse_args()
    path = initialize(Path(os.getenv("DATA_DIR", "data")), demo=os.getenv("SEED_DEMO", "1") == "1")
    if args.command == "remove-samples":
        with connect(path, write=True) as db:
            count = db.execute("DELETE FROM posts WHERE demo = 1").rowcount
        print(f"Removed {count} sample stories.")
        return
    username = args.username.strip()
    if not re.fullmatch(r"[A-Za-z0-9_.-]{3,60}", username):
        parser.error("Use 3–60 letters, numbers, periods, underscores, or hyphens for the username.")
    password = getpass("Password (at least 12 characters): ")
    if not 12 <= len(password) <= 256:
        parser.error("Use a password between 12 and 256 characters.")
    if password != getpass("Repeat password: "):
        parser.error("The passwords did not match.")
    digest = hash_password(password)
    with connect(path, write=True) as db:
        db.execute(
            """INSERT INTO admin VALUES (1, ?, ?)
               ON CONFLICT(id) DO UPDATE SET username = excluded.username, password_hash = excluded.password_hash""",
            (username, digest),
        )
        db.execute("DELETE FROM sessions")
    print("Admin sign-in is ready at /admin.")


if __name__ == "__main__":
    main()
