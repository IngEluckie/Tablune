import { pythonLanguage } from "@codemirror/lang-python";

export interface FormulaFunction {
  name: string;
  label: string;
  signature: string;
  description: string;
  example: string;
  note: string;
  category: string;
  project?: boolean;
}

export const BUILTIN_FUNCTIONS: FormulaFunction[] = [
  { name: "sum", label: "Suma", signature: "sum(valores, start=0)", description: "Suma los valores de un rango.", example: '=sum(cells("A1:C1"))', note: "Los valores deben ser numéricos. Las celdas vacías y el texto pueden producir un error.", category: "Matemáticas" },
  { name: "min", label: "Mínimo", signature: "min(valores)", description: "Obtiene el menor valor del rango.", example: '=min(cells("A1:C1"))', note: "Usa valores de tipos comparables. Un rango con celdas vacías puede producir un error.", category: "Matemáticas" },
  { name: "max", label: "Máximo", signature: "max(valores)", description: "Obtiene el mayor valor del rango.", example: '=max(cells("A1:C1"))', note: "Usa valores de tipos comparables. Un rango con celdas vacías puede producir un error.", category: "Matemáticas" },
  { name: "abs", label: "Valor absoluto", signature: "abs(numero)", description: "Obtiene un número sin su signo negativo.", example: "=abs(A1)", note: "Requiere un número.", category: "Matemáticas" },
  { name: "round", label: "Redondear", signature: "round(numero, ndigits=0)", description: "Redondea un número a los decimales indicados.", example: "=round(A1 / B1, 2)", note: "Usa el redondeo de Python: los empates se redondean hacia el número par más cercano.", category: "Matemáticas" },
  { name: "len", label: "Cantidad / longitud", signature: "len(valor)", description: "Cuenta las posiciones de un rango o los caracteres de un texto.", example: '=len(cells("A1:C1"))', note: "En un rango cuenta también las posiciones vacías; no equivale a contar solo números.", category: "Texto y rangos" },
  { name: "int", label: "Convertir a entero", signature: "int(valor)", description: "Convierte un número o texto compatible en un entero.", example: "=int(A1)", note: "En números decimales elimina la parte fraccionaria hacia cero.", category: "Conversión" },
  { name: "float", label: "Convertir a decimal", signature: "float(valor)", description: "Convierte un número o texto compatible en un decimal.", example: "=float(A1)", note: "El texto decimal usa punto; los separadores regionales no se convierten automáticamente.", category: "Conversión" },
  { name: "str", label: "Convertir a texto", signature: "str(valor)", description: "Convierte un valor en texto.", example: "=str(A1)", note: 'Una celda vacía se convierte en el texto "None".', category: "Conversión" },
  { name: "bool", label: "Convertir a booleano", signature: "bool(valor)", description: "Convierte un valor en True o False con las reglas de Python.", example: "=bool(A1)", note: 'Cero, texto vacío y None dan False. Un texto no vacío, incluso "False", da True.', category: "Conversión" },
  { name: "cells", label: "Valores de un rango", signature: 'cells("A1:B2")', description: "Obtiene los valores del rango, ordenados por filas.", example: '=sum(cells("A1:C1"))', note: "Devuelve una lista. Combínala con sum, min, max, len o una función del proyecto para obtener un resultado individual.", category: "Texto y rangos" },
];

export function projectFunctions(code: string): FormulaFunction[] {
  const functions = new Map<string, FormulaFunction>();
  const reserved = new Set(BUILTIN_FUNCTIONS.map(f => f.name));
  const root = pythonLanguage.parser.parse(code).topNode;
  for (let node = root.firstChild; node; node = node.nextSibling) {
    const definition = node.name === "DecoratedStatement" ? node.getChild("FunctionDefinition") : node;
    if (definition?.name !== "FunctionDefinition") continue;
    const nameNode = definition.getChild("VariableName");
    if (!nameNode || definition.getChild("async")) continue;
    const name = code.slice(nameNode.from, nameNode.to);
    if (name.startsWith("_") || reserved.has(name) || /^[A-Z]+[1-9][0-9]*$/.test(name)) continue;
    const params = definition.getChild("ParamList");
    const signature = name + (params ? code.slice(params.from, params.to) : "()");
    const statement = definition.getChild("Body")?.getChild("ExpressionStatement");
    // A docstring is the first statement, never a later string expression.
    const bodyFirst = definition.getChild("Body")?.firstChild?.nextSibling;
    const doc = bodyFirst?.from === statement?.from ? statement?.getChild("String") : null;
    const raw = doc ? code.slice(doc.from, doc.to) : "";
    const description = raw.replace(/^[ru]*(?:"""|'''|"|')/i, "").replace(/(?:"""|'''|"|')$/, "").trim().split("\n")[0];
    functions.set(name, { name, label: name, signature, description: description || "Función definida en el módulo de este proyecto.", example: `=${name}()`, note: "Consulta sus argumentos en el módulo. Debe devolver un único valor.", category: "Del proyecto", project: true });
  }
  return [...functions.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function appliedFunctionNames(code: string): string[] {
  return projectFunctions(code).map(f => f.name);
}

export function searchFunctions(functions: FormulaFunction[], query: string) {
  const normalize = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const words = normalize(query).trim().split(/\s+/);
  return functions.filter(f => words.every(word => normalize(`${f.name} ${f.label} ${f.description} ${f.category}`).includes(word)));
}

export function newFunctionDraft(code: string) {
  let name = "mi_funcion";
  let suffix = 2;
  while (new RegExp(`\\b${name}\\b`).test(code)) name = `mi_funcion_${suffix++}`;
  return `${code.trimEnd()}${code.trim() ? "\n\n" : ""}def ${name}(valor):\n    """Describe aquí qué calcula esta función."""\n    return valor\n`;
}
