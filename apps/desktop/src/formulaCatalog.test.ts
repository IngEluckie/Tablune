import { expect, it } from "vitest";
import { BUILTIN_FUNCTIONS, newFunctionDraft, projectFunctions, searchFunctions } from "./formulaCatalog";

it("finds Python names through Spanish labels without accents", () => {
  expect(searchFunctions(BUILTIN_FUNCTIONS, "minimo").map(f => f.name)).toEqual(["min"]);
  expect(searchFunctions(BUILTIN_FUNCTIONS, "redondear").map(f => f.name)).toEqual(["round"]);
  expect(BUILTIN_FUNCTIONS.map(f => f.name)).toEqual(["sum", "min", "max", "abs", "round", "len", "int", "float", "str", "bool", "cells"]);
});
it("reads signatures and docstrings without executing code or listing reserved/private functions", () => {
  const functions = projectFunctions('"""def fake(): pass"""\ndef _helper(): pass\ndef sum(): pass\ndef A1(): pass\ndef precio(base, impuesto=0.16):\n    """Calcula el precio final.\n    Otra línea.\n    """\n    return base\n');
  expect(functions).toHaveLength(1);
  expect(functions[0]).toMatchObject({ name: "precio", signature: "precio(base, impuesto=0.16)", description: "Calcula el precio final." });
});
it("only uses a string as documentation if it is the first statement", () => {
  expect(projectFunctions('def foo():\n    x = 1\n    "Not documentation"\n    return x')[0].description).toContain("módulo");
});
it("appends a unique function without replacing existing helpers or imports", () => {
  const code = "import math\n\ndef mi_funcion(valor):\n    return math.ceil(valor)\n";
  const draft = newFunctionDraft(code);
  expect(draft).toContain(code.trimEnd());
  expect(draft).toContain("def mi_funcion_2(valor):");
  expect(projectFunctions(draft).map(f => f.name)).toEqual(["mi_funcion", "mi_funcion_2"]);
});
