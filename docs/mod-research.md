# Notas de investigación del sistema de mods

Antes de escribir la Mod API se comprobó, contra un runtime real, qué se puede hacer de verdad. Este documento recoge qué se verificó, cómo, y qué **no**.

## Qué runtime usan los juegos

Los juegos de Scratch exportados con el **TurboWarp Packager** se ejecutan sobre `scaffolding`, que envuelve `scratch-vm` + `scratch-render`, y la versión de escritorio es una app **Electron o NW.js**, es decir, un proceso Chromium. El VM queda accesible desde la página (TurboWarp documenta `vm` como global convencional).

## Verificado contra un `scratch-vm` real

Se cargó `@turbowarp/scaffolding` en un Chromium real con un proyecto `.sb3` y se comprobó:

| Prueba | Resultado |
|---|---|
| Leer y cambiar una variable en caliente (`runtime.targets[].variables`) | funciona, sin tocar el proyecto |
| Crear un sprite que no existía (`vm.duplicateSprite`) | funciona; hay que quitarle los scripts copiados |
| Cargar un asset externo (PNG/SVG) como disfraz (`storage.createAsset` + `vm.addCostume`) | funciona |
| Reemplazar un disfraz conservando el nombre (`addCostume` + `deleteCostume` + `reorderCostume`) | funciona |
| Añadir y reemplazar un sonido (`vm.addSound` / `deleteSound`) | funciona |
| Eventos reales: `PROJECT_START`, `PROJECT_STOP_ALL`, `targetWasCreated/Removed`, `AFTER_EXECUTE` | existen |
| Un único punto de entrada para teclado y ratón (`ioDevices.*.postData`) | funciona; también recoge las teclas inyectadas |
| Interceptar funciones internas envolviendo el prototipo (`RenderedTarget.prototype.setXY`) | funciona y es reversible |
| Inyectar teclado con `vm.postIOData('keyboard', …)` | funciona (base del mando) |
| Congelar el bucle de fotogramas sustituyendo `runtime._step` | funciona |

## Cómo se entra en un juego que Pitch no controla

Pitch lanza el juego como proceso aparte. Para entrar, lo arranca con `--remote-debugging-port=<puerto>` (solo en 127.0.0.1) y habla con él por el **Chrome DevTools Protocol** (`Runtime.evaluate`, `Runtime.addBinding`), el mismo mecanismo de las herramientas de desarrollo de Chrome. No se modifica ningún archivo del juego. Verificado con un proceso Electron real lanzado por Pitch.

## Qué no existe de fábrica (y cómo se resuelve)

- **"Jugador"**: Scratch no tiene ese concepto. `Pitch.players.define` deja que el mod diga qué sprite y qué variable de vida son, y de ahí se derivan `playerMove/Damage/Death/Spawn`.
- **`variableChanged`**: no hay evento nativo; se deriva comparando valores por fotograma.
- **Pausa**: `scratch-vm` no la tiene; se congela `_step`.
- **Crear un sprite desde la nada**: no es posible; se clona uno existente y se limpia.

## Lo que NO se ha podido verificar

- Un juego exportado **realmente** con el TurboWarp Packager: las pruebas usan `@turbowarp/scaffolding` (el mismo motor) en una página y en una app Electron de prueba, no un `.exe/.app` salido del Packager. Variantes de empaquetado que oculten el `vm` no se detectarían (Pitch lo avisa y abre el juego sin mods).
- Exportaciones NW.js, y cualquier prueba en **macOS o Windows** (todo se probó en Linux).
- El mando con un dispositivo físico: se probó con un mando simulado (`navigator.getGamepads`) contra el teclado real del VM.
- Otros runtimes (Forkphorus, etc.): la arquitectura de adaptadores está preparada (`src/main/mods/adapters`), pero solo existe el de `scratch-vm`.
