"""Versioned bridge between Tablune and user-authored Python macros."""

from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path
from typing import Any


PROTOCOL_VERSION = 1


def fail(message: str) -> "None":
    raise ValueError(message)


def validate_rows(value: Any) -> list[list[str]]:
    if not isinstance(value, list):
        fail("transform() must return rows as a list")
    for row_index, row in enumerate(value):
        if not isinstance(row, list):
            fail(f"row {row_index} is not a list")
        for column_index, cell in enumerate(row):
            if not isinstance(cell, str):
                fail(f"cell ({row_index}, {column_index}) is not a string")
    return value


def validate_headers(value: Any, header_enabled: bool) -> list[str] | None:
    if not header_enabled:
        if value is not None:
            fail("headers must remain null when the document header is disabled")
        return None
    if not isinstance(value, list) or not all(isinstance(cell, str) for cell in value):
        fail("headers must be a list of strings")
    return value


def load_macro(path: Path):
    source_directory = os.environ.get("TABLUNE_MACRO_DIR")
    if source_directory:
        sys.path.insert(0, source_directory)
    spec = importlib.util.spec_from_file_location("tablune_user_macro", path)
    if spec is None or spec.loader is None:
        fail("the macro module could not be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    transform = getattr(module, "transform", None)
    if not callable(transform):
        fail("the macro must define transform(rows, context)")
    return transform


def main() -> None:
    if len(sys.argv) != 4:
        fail("usage: tablune_runner.py INPUT_JSON MACRO_PY OUTPUT_JSON")
    input_path, macro_path, output_path = map(Path, sys.argv[1:])
    payload = json.loads(input_path.read_text(encoding="utf-8"))
    if payload.get("protocolVersion") != PROTOCOL_VERSION:
        fail("unsupported Tablune macro protocol version")

    rows = validate_rows(payload.get("rows"))
    context = payload.get("context")
    if not isinstance(context, dict):
        fail("macro context is invalid")
    header_enabled = context.get("header_enabled") is True
    original_headers = validate_headers(context.get("headers"), header_enabled)

    transform = load_macro(macro_path)
    result = transform(rows, context)
    headers = original_headers
    if isinstance(result, dict):
        if "rows" not in result:
            fail("transform() result is missing rows")
        rows = validate_rows(result["rows"])
        headers = validate_headers(result.get("headers"), header_enabled)
    else:
        rows = validate_rows(result)

    output_path.write_text(
        json.dumps(
            {"protocolVersion": PROTOCOL_VERSION, "rows": rows, "headers": headers},
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
