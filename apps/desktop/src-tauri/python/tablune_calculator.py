"""Persistent protocol worker. Evaluates validated expression trees, not cell source text.

User functions execute with normal interpreter permissions after session authorization.
Each request gets a fresh module namespace; spreadsheet access is only through arguments.
"""
from __future__ import annotations
import builtins
import contextlib
import io
import json
import math
import operator
import os
from pathlib import Path
import re
import sys
import types

PROTOCOL_VERSION = 1
OUTPUT_LIMIT = 512 * 1024 * 1024
LOG_LIMIT = 1024 * 1024
BUILTINS = {name: getattr(builtins, name) for name in (
    "sum", "min", "max", "abs", "round", "len", "int", "float", "str", "bool"
)}
OPERATORS = {"add": operator.add, "sub": operator.sub, "mul": operator.mul,
             "div": operator.truediv, "floordiv": operator.floordiv, "mod": operator.mod,
             "pow": operator.pow, "eq": operator.eq, "ne": operator.ne,
             "lt": operator.lt, "le": operator.le, "gt": operator.gt, "ge": operator.ge}

class BoundedLog(io.TextIOBase):
    def __init__(self):
        self.parts, self.size, self.truncated = [], 0, False
    def write(self, value):
        text = str(value)
        available = LOG_LIMIT - self.size
        if available > 0:
            self.parts.append(text[:available])
            self.size += len(text[:available])
        self.truncated |= len(text) > available
        return len(text)
    def getvalue(self):
        return "".join(self.parts) + ("\n[output truncated]" if self.truncated else "")

class CellFailure(Exception):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)

def scalar(value):
    if value is None: return {"kind": "blank", "text": ""}
    if type(value) is bool: return {"kind": "boolean", "text": str(value)}
    if type(value) is int: return {"kind": "integer", "text": str(value)}
    if type(value) is float and math.isfinite(value): return {"kind": "decimal", "text": str(value)}
    if type(value) is str: return {"kind": "text", "text": value}
    raise CellFailure("#VALUE!", "A function must return a text, integer, finite decimal, boolean or None")

def decode(value):
    kind, text = value["kind"], value["text"]
    if kind == "blank": return None
    if kind == "integer": return int(text)
    if kind == "decimal": return float(text)
    if kind == "boolean": return text == "True"
    if kind == "text": return text
    raise CellFailure("#VALUE!", "Unsupported cell value")

def error_result(code, message):
    return {"value": None, "error": {"code": code, "message": message}, "display": code}

def load_functions(code):
    module = types.ModuleType("tablune_functions")
    exec(compile(code, "Functions.py", "exec"), module.__dict__)
    functions = {}
    for name, value in module.__dict__.items():
        if name.startswith("_") or not isinstance(value, types.FunctionType) or value.__module__ != module.__name__:
            continue
        if name in BUILTINS or name == "cells" or re.fullmatch(r"[A-Z]+[1-9][0-9]*", name):
            raise ValueError(f"Reserved function name: {name}")
        if value.__code__.co_flags & (0x20 | 0x80 | 0x200):
            raise ValueError(f"Function {name} must be synchronous and return a scalar")
        functions[name] = value
    return {**BUILTINS, **functions}

def evaluate(tree, values, functions):
    def visit(node):
        op = node["op"]
        if op == "literal": return decode(node["value"])
        if op == "cell": return cell(node["key"])
        if op == "refError": raise CellFailure("#REF!", "A referenced cell or range was deleted")
        if op == "range":
            a, b = node["start"], node["end"]
            count = (abs(a[0]-b[0])+1) * (abs(a[1]-b[1])+1)
            if count > 50_000_000: raise CellFailure("#VALUE!", "Range exceeds the cell limit")
            return [cell(f"{r},{c}") for r in range(min(a[0],b[0]),max(a[0],b[0])+1)
                    for c in range(min(a[1],b[1]),max(a[1],b[1])+1)]
        if op in OPERATORS: return OPERATORS[op](visit(node["left"]), visit(node["right"]))
        if op == "pos": return +visit(node["value"])
        if op == "neg": return -visit(node["value"])
        if op == "not": return not visit(node["value"])
        if op == "if": return visit(node["yes"] if visit(node["test"]) else node["no"])
        if op in ("and", "or"):
            value = None
            for item in node["values"]:
                value = visit(item)
                if (op == "and" and not value) or (op == "or" and value): break
            return value
        if op == "compare":
            previous = visit(node["left"])
            for operation, expression in zip(node["ops"], node["values"]):
                current = visit(expression)
                if not OPERATORS[operation](previous, current): return False
                previous = current
            return True
        if op == "call":
            function = functions.get(node["name"])
            if function is None: raise CellFailure("#NAME?", f"Unknown function: {node['name']}")
            return function(*[visit(arg) for arg in node["args"]],
                            **{name: visit(arg) for name, arg in node["kwargs"].items()})
        raise CellFailure("#SYNTAX!", "Unsupported expression node")
    def cell(key):
        result = values.get(key)
        if result is None: return None
        if result.get("error"):
            error = result["error"]
            raise CellFailure(error["code"], f"Referenced cell: {error['message']}")
        return decode(result["value"])
    return visit(tree)

def handle(payload):
    if payload.get("protocolVersion") != PROTOCOL_VERSION: raise ValueError("Unsupported calculator protocol")
    functions = load_functions(payload.get("code", ""))
    if payload.get("validateOnly"):
        return {"functions": sorted(set(functions)-set(BUILTINS)), "results": []}
    outputs = []
    for sheet in payload.get("sheets", []):
        values = dict(sheet["values"])
        results = dict(sheet.get("errors", {}))
        values.update(results)
        for item in sheet["formulas"]:
            try:
                value = scalar(evaluate(item["tree"], values, functions))
                result = {"value": value, "error": None, "display": value["text"]}
            except CellFailure as error:
                result = error_result(error.code, str(error))
            except ZeroDivisionError as error:
                result = error_result("#DIV/0!", str(error))
            except (TypeError, ValueError, OverflowError) as error:
                result = error_result("#VALUE!", str(error))
            except Exception as error:
                result = error_result("#PYTHON!", f"{type(error).__name__}: {error}")
            values[item["key"]] = result
            results[item["key"]] = result
        outputs.append({"documentId": sheet["documentId"], "revision": sheet["revision"], "results": results})
    return {"results": outputs}

def main():
    for line in sys.stdin:
        command = json.loads(line)
        input_path, output_path = Path(command["input"]), Path(command["output"])
        stdout, stderr = BoundedLog(), BoundedLog()
        try:
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                output = handle(json.loads(input_path.read_text(encoding="utf-8")))
        except BaseException as error:
            output = {"error": f"{type(error).__name__}: {error}"}
        output.update(protocolVersion=PROTOCOL_VERSION, stdout=stdout.getvalue(), stderr=stderr.getvalue())
        encoded = json.dumps(output, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
        if len(encoded) > OUTPUT_LIMIT:
            encoded = json.dumps({"protocolVersion": PROTOCOL_VERSION, "error": "Calculation output exceeds 512 MiB"}).encode()
        temporary = output_path.with_suffix(".tmp")
        temporary.write_bytes(encoded)
        os.replace(temporary, output_path)

if __name__ == "__main__":
    main()
