# Combinar celdas

En tablas de un proyecto, selecciona un rectángulo y abre **Formato**:

- **Combinar celdas** conserva la alineación de la esquina superior izquierda.
- **Combinar y centrar** combina y centra horizontalmente el contenido.
- **Separar celdas** devuelve el bloque a celdas independientes.

Admite bloques horizontales, verticales y rectangulares. Solamente la esquina
superior izquierda puede tener contenido: texto, fórmula o imagen. Las demás
celdas deben estar vacías; una fórmula que muestre un resultado vacío también
cuenta como contenido. Los errores identifican la celda ocupada y no modifican
la hoja. No se concatenan ni descartan valores automáticamente.

Haz clic en cualquier parte para seleccionar el bloque completo. Doble clic, F2,
la barra de fórmulas o escribir editan su celda principal. Flechas y Tab saltan el
bloque; Mayús amplía la selección. Una selección que toca una combinación se
amplía para incluirla completa. No se admiten solapamientos parciales. Es posible
combinar una selección mayor que contiene combinaciones completas si cumple la
regla de contenido. El ancho y alto son la suma de sus columnas y filas.

El estilo visible parte de la celda principal y los bordes exteriores se resuelven
sobre el perímetro. Se ocultan divisiones y bordes interiores. El formato original
de las celdas cubiertas permanece disponible al separar. Quitar formato conserva
la combinación; Suprimir borra el contenido y conserva la combinación. Separar
conserva el contenido en la esquina superior izquierda. Las tres operaciones de
combinación participan en deshacer/rehacer sin recalcular fórmulas.

## Datos y operaciones

Las direcciones mantienen su significado: al combinar A1:C1, el contenido pertenece
a A1. B1 y C1 siguen vacías para los cálculos. No se crean alias ni se repite el
valor al sumar. Exportar CSV conserva el valor de la celda principal y campos
vacíos para las celdas cubiertas; CSV no representa el formato visual. Desde un
CSV independiente, Formato ofrece crear un proyecto para conservar combinaciones.

Copiar un bloque completo entre tablas de proyectos conserva combinaciones,
fórmulas, imágenes y formato cuando se reconoce el portapapeles interno. El
pegado es una sola acción de historial y rechaza operaciones que cortan una
combinación existente. Pegar un valor único sobre un bloque escribe en su celda
principal. Pegar valores no copia la combinación. El texto externo conserva la
representación rectangular; los datos destinados a celdas cubiertas se rechazan.
Cortar borra el contenido del origen y conserva su formato y combinación.

Una hoja con combinaciones no admite ordenar, aplicar una ordenación ni filtrar.
Tampoco se puede combinar mientras haya ordenación o filtros activos. Se pueden
insertar/eliminar filas y columnas fuera del bloque: las combinaciones se desplazan.
Insertar dentro, o eliminar filas/columnas que lo atraviesan, requiere separarlo
primero. Se rechazan cambios que excedan los límites de la hoja.

## Persistencia y límites

El formato 8 de `.tablune` agrega `sheet.merges` a los datos de cada tabla. Se leen
formatos 1–7. El guardado, la recuperación y la duplicación conservan los rangos.
Cada hoja admite 1000 combinaciones y hasta 100 000 celdas combinadas en total.
Rust valida límites, solapamientos, contenido y compatibilidad de vistas antes de
aceptar cambios o abrir un archivo. Las regiones y su contenido participan en
la misma transacción de pegado e historial.

La cuadrícula sigue dibujando una ventana del documento; las regiones que la
intersectan incluyen los datos de su celda principal aunque esta esté fuera de
pantalla. También se cargan sus imágenes para renderizar el bloque completo.
