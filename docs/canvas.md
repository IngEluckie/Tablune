# Lienzos del proyecto

En **Explorador → ＋ → Nuevo lienzo**, crea un documento visual en la carpeta
seleccionada. Se abre en una pestaña del área principal. El menú del explorador
permite renombrar, mover, duplicar o eliminar el lienzo. Cerrar su pestaña no lo
elimina. También puedes crear un lienzo independiente desde **Home → New canvas**. Se abre
sin explorador de proyecto y se guarda como `.tlcanvas`, con sus imágenes dentro
del mismo archivo. **Open…** y los recientes vuelven a abrirlo; participa en
autoguardado, protección al cerrar y recuperación. Los vínculos a documentos están
disponibles al trabajar dentro de un proyecto.

## Edición

La barra permite insertar rectángulos, rectángulos redondeados, elipses, rombos,
texto, notas e imágenes PNG/JPEG locales. Seleccionar un objeto abre propiedades
flotantes: texto, colores, borde, tamaño y alineación de texto. Doble clic en una
forma enfoca su texto. Arrastra para mover; el control de la esquina inferior
derecha cambia su tamaño. Las imágenes conservan su proporción al renderizarse.

Mayús+clic o un rectángulo de selección seleccionan varios objetos. Las
propiedades ofrecen agrupar/desagrupar, alinear, distribuir y ordenar al frente o
al fondo. Los grupos se seleccionan y mueven juntos; redimensionar una figura
cambia esa figura. Ctrl/Cmd+C, X, V y D copian, cortan, pegan y duplican. El
portapapeles del lienzo es interno y compartido entre lienzos del mismo proyecto.
Copiar un conector incluye sus figuras extremas.
Ctrl/Cmd+G agrupa; Ctrl/Cmd+Mayús+G desagrupa. Suprimir elimina la selección y sus
conectores incidentes en una sola acción de historial. Flechas desplazan un píxel;
Mayús+flecha desplaza diez.

**Trazo libre** dibuja al arrastrar con mouse, lápiz o pantalla táctil, incluso
sobre figuras existentes. La barra ofrece color y grosor. Cada gesto completo
crea un objeto que se puede seleccionar, mover, redimensionar, duplicar o eliminar;
se deshace en un solo paso. Escape cancela el trazo en curso y vuelve a selección.
Los trazos se guardan y exportan como el resto del lienzo.

**Conector** permite elegir origen y destino, usando los puntos de los cuatro
lados. También puedes comenzar directamente desde un punto de una figura
seleccionada. Las conexiones conservan sus extremos al mover o redimensionar
figuras. Sus propiedades permiten texto, recorrido recto/en ángulo, desplazamiento
manual del recorrido, flechas y reconexión de extremos. Escape cancela una
conexión. No hay evitación automática de obstáculos.

La rueda desplaza el lienzo; Ctrl/Cmd+rueda cambia el zoom alrededor del puntero.
La herramienta Mano, el botón central o Espacio+arrastrar desplazan la vista.
**Ver todo** encuadra el contenido. Cuadrícula y ajuste a cuadrícula son opcionales.
El encuadre se conserva localmente por proyecto y lienzo; no modifica el archivo.

## Tarjetas vinculadas

Arrastra una tabla, Markdown o script del explorador, o usa **Vincular**. La tarjeta
muestra el tipo, nombre y ruta actuales. Doble clic o **Abrir documento** abre el
destino en una pestaña principal y conserva el lienzo; abrir un script no lo ejecuta.

Los vínculos usan identificadores estables dentro del mismo proyecto. Renombrar o
mover el destino no rompe el vínculo. Si se elimina, permanece la tarjeta con su
último nombre conocido y **Documento no disponible**; **Cambiar vínculo** permite
reasignarla. Duplicar una tarjeta conserva su destino. Borrar la tarjeta no borra
el documento. Las flechas son relaciones visuales, no instrucciones de ejecución.

## Guardado y exportación

Ctrl/Cmd+S guarda el proyecto completo. Los lienzos participan en autoguardado,
protección al cerrar y recuperación. Las actualizaciones verifican la revisión;
un fallo conserva el borrador para reintentar. Guardar espera las importaciones
de imágenes pendientes. El historial local conserva hasta 80 estados con un
presupuesto aproximado de 32 MiB (se retiene al menos un estado anterior).

**Exportar** ofrece PNG o SVG, todo el contenido o la selección y fondo
transparente opcional. Seleccionar solo un conector incluye sus figuras extremas
para conservar el contexto. Las imágenes se incluyen en el SVG. PNG está limitado
a 25 megapíxeles y 16 384 píxeles por lado. Exportar no marca el proyecto como
guardado. Las exportaciones son visuales; el documento editable está en `.tablune`.

El formato 7 añade `canvases/<id>.json` y metadatos al manifiesto. Las imágenes usan
el almacén compartido del proyecto y sobreviven al traslado del archivo. Se leen
formatos 1–6 y se guardan como 7, que requiere una aplicación compatible. Cada
lienzo admite hasta 10 000 elementos y 16 MiB de contenido, con validación de
geometría, colores, conectores y recursos en Rust. Los límites de imágenes siguen
siendo 20 MiB/25 megapíxeles por imagen y 256 MiB de recursos al importar.

## Verificación

Las pruebas cubren geometría de conexiones, eliminación de grupos, duplicación y
vínculos, distribución, edición e historial, guardar con texto pendiente, conservar
borradores al fallar, revisión concurrente, carpetas, duplicación de lienzos,
compatibilidad de archivo y recursos de imagen exclusivos del lienzo.

La prueba de producción en Chromium con IPC simulado verifica crear y arrastrar
formas, conectar, vincular, guardar y generar SVG/PNG. Los diálogos nativos y el
comportamiento de WebKit deben comprobarse en la aplicación empaquetada.
