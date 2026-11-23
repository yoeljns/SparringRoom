"""Write worker/mechanics/schemas.json (code -> param schema) from the registry.

    uv run python scripts/emit_mechanic_schemas.py [--check]
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import mechanics  # noqa: E402

OUT = Path(mechanics.__file__).with_name("schemas.json")


def render() -> str:
    return json.dumps(mechanics.schemas(), indent=2, sort_keys=True, ensure_ascii=False) + "\n"


if __name__ == "__main__":
    text = render()
    if "--check" in sys.argv:
        if not OUT.exists() or OUT.read_text(encoding="utf-8") != text:
            sys.exit("schemas.json is out of date; run scripts/emit_mechanic_schemas.py")
        print("schemas.json is up to date")
    else:
        OUT.write_text(text, encoding="utf-8")
        print(f"wrote {OUT}")
