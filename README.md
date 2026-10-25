# Visor TAC

Convierte el CD de un TAC (tomografía computarizada) en un visor web local: los cortes ordenados, un recorrido milímetro a milímetro en los tres planos, videos y una reconstrucción 3D del cráneo con los senos paranasales.

*Turn the DICOM CD from a CT scan into a local web viewer: ordered slices, millimetre-by-millimetre MPR, videos, and a 3D skull reconstruction with the paranasal sinuses. Spanish UI.*

Todo corre en tu computador. Los estudios no se suben a ningún lado.

## Qué hace

| Pestaña | Contenido |
|---|---|
| **Cortes** | Cada serie del CD ordenada por posición anatómica. Rueda o ↑↓ para avanzar, espacio para reproducir como video, ventanas predefinidas (hueso, senos, tejido blando, cerebro), regla de medición y valor HU bajo el cursor. |
| **Cada milímetro** | El volumen reconstruido en axial, coronal y sagital con cruz sincronizada. La rueda avanza 0.5 mm. |
| **Cráneo 3D** | *Superficie*: malla del hueso con vistas, plano de corte, capa de senos y vía aérea, video 360°, PNG y STL para imprimir. *Volumen*: render directo de los vóxeles (hueso, piel, MIP). |
| **Videos** | MP4 de cada serie y recorridos cada 1 mm del volumen reconstruido. |

## Uso

Necesitas Python 3.11+, Node 20.19+ y, para el video 360°, Google Chrome.

**1. Copia el estudio.** Pon la carpeta del CD (la que tiene `DICOMDIR`, o cualquier carpeta con los archivos DICOM) en `data/raw/`. El pipeline busca recursivamente y descarta lo que no sea imagen CT.

**2. Procésalo:**

```bash
python3 -m venv .venv
.venv/bin/pip install -r pipeline/requirements.txt
.venv/bin/python pipeline/build.py
```

Tarda uno o dos minutos y escribe todo en `web/public/data/`. Opciones: `--threshold 250` (umbral óseo de la malla, en HU), `--spacing 0.5` (vóxel en mm), `--refuse` (recalcular la reconstrucción en vez de usar la caché) y `--skip-videos`.

**3. Abre el visor:**

```bash
cd web
npm install
npm run dev
```

y entra a http://localhost:5173.

**Video 360° (opcional).** Con el servidor corriendo:

```bash
cd web && npm run video:360
```

Graba cada cuadro con Chrome headless, así que el video no depende de la fluidez del navegador. Para cambiar opciones, corre los dos pasos por separado desde `web/`: `node scripts/render-360.mjs --hueso 0.4 --aire 0 --size 1080 --url http://localhost:5173` (opacidad del hueso, sin capa de senos, tamaño, servidor) y luego `../.venv/bin/python ../pipeline/turntable.py` (con `--sin-aire` si quitaste los senos).

## Cómo funciona

1. **Ordena** cada serie por la posición real de sus cortes (`ImagePositionPatient`), no por el número de archivo, y descarta los localizadores.
2. **Reconstruye un volumen isotrópico de 0.5 mm.** Muchos CD solo traen reconstrucciones gruesas (3 mm) en axial, coronal y sagital. Cada serie es nítida en su plano y borrosa a lo largo de su normal, así que el pipeline las combina: modela cada corte como el promedio de su espesor sobre el volumen real y resuelve por mínimos cuadrados con gradiente conjugado ([`pipeline/fusion.py`](pipeline/fusion.py)). El resultado tiene mucho menos efecto escalera que interpolar una sola serie. Si el CD trae cortes finos, el pipeline los prefiere y el resultado es todavía más nítido.
3. **Extrae superficies** con marching cubes ([`pipeline/mesh.py`](pipeline/mesh.py)): el hueso por umbral de densidad, y el aire interno (senos, fosas nasales, vía aérea, mastoides), que se separa del aire exterior con una máscara de la cabeza y exigiendo contacto con hueso.
4. **Genera videos** H.264 de cada serie y del volumen reconstruido.

El modelo 3D sale de las densidades medidas en el estudio. No hay un cráneo de plantilla ni IA de por medio.

## Stack

- **Pipeline**: Python con pydicom, NumPy/SciPy, scikit-image, trimesh e imageio-ffmpeg.
- **Visor**: Vite + React + TypeScript, [Cornerstone3D](https://www.cornerstonejs.org/) (el motor de OHIF) para DICOM, MPR y volume rendering, y three.js con react-three-fiber para las mallas.

## Límites

- Pensado para TAC de cabeza. Lee series CT clásicas (un archivo por corte). Las Enhanced CT multi-frame todavía no están soportadas.
- El volumen de 0.5 mm es una reconstrucción calculada, no una adquisición: los detalles finos en diagonal a los tres planos siguen limitados por el grosor original de los cortes, y las paredes óseas muy delgadas pueden aparecer con huecos en la malla.
- Donde el estudio deja de tener cortes, el cráneo termina en un borde plano.

## Privacidad

- Este repositorio no incluye ningún estudio. `data/` y `web/public/data/`, y cualquier DICOM, malla o video, están en `.gitignore`.
- Las copias de los cortes que usa el visor se anonimizan: se borran el nombre, los identificadores, la fecha de nacimiento, la institución, los médicos y los tags privados del fabricante.
- Ojo: la reconstrucción 3D (en especial el preset *Piel*) puede mostrar la cara de la persona. Piénsalo antes de compartir capturas o videos.

## Aviso

Herramienta educativa y de uso personal. No es un dispositivo médico y no reemplaza el informe de un radiólogo.

## Licencia

[MIT](LICENSE)
