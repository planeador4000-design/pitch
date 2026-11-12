# Guía de mods de Pitch (Mod API 1.0)

Pitch puede aplicar mods a un juego de Scratch exportado **sin tocar sus archivos**: al pulsar *Jugar*, Pitch abre el juego, entra en él y carga tus mods en memoria. Al cerrar el juego no queda nada modificado, y desinstalar o desactivar un mod basta para quitarlo.

> Ejemplo completo y funcional: [`mods-example/zombie-expansion`](../mods-example/zombie-expansion).

## Qué juegos funcionan

Pitch necesita poder "entrar" en el juego. Eso funciona con juegos de Scratch/TurboWarp exportados como **app de escritorio basada en Chromium** (Electron o NW.js, que es lo que genera el TurboWarp Packager). No funciona con ejecutables que no sean Chromium, ni con juegos cuyo runtime oculte el `vm` de Scratch. Si un juego no es compatible, Pitch lo abre igualmente **sin mods** y te avisa.

## Estructura de un mod

```
mi-mod/
├── mod.json        ← obligatorio
├── main.js         ← archivo principal (el que pone "main")
├── assets/         ← imágenes (PNG, JPG, SVG)
├── audio/          ← sonidos (WAV, MP3)
└── data/           ← JSON y otros datos
```

### mod.json

```json
{
  "id": "zombie-expansion",
  "name": "Zombie Expansion",
  "version": "1.0.0",
  "author": "Roud",
  "description": "Añade zombis y oleadas.",
  "main": "main.js",
  "pitchApi": "1.0",
  "minPitchVersion": "0.1.0",
  "category": "content",
  "dependencies": { "pitch-combat-api": ">=1.2.0" },
  "permissions": ["game", "graphics", "audio", "storage", "ui"],
  "compatibility": { "games": ["*"], "runtimes": ["scratch-vm"] },
  "modifies": ["Weapon.damage"],
  "incompatibleWith": ["otro-mod"]
}
```

| Campo | Obligatorio | Notas |
|---|---|---|
| `id` | sí | minúsculas, números, `.`, `-`, `_` (2–64). La carpeta del mod se llama igual. |
| `name`, `version` | sí | `version` es semver (`1.0.0`). |
| `pitchApi` | sí | Mod API para la que lo escribiste (`"1.0"`). Se carga si el mayor coincide y el menor no es más nuevo que el de Pitch. |
| `main` | no | `main.js` por defecto. Tiene que estar dentro de la carpeta del mod. |
| `category` | no | `framework`, `content` (por defecto), `gameplay`, `balance`. Define el orden de carga. |
| `dependencies` | no | `{ "id-del-mod": "rango semver" }`. |
| `permissions` | no | Lista de permisos (ver abajo). |
| `compatibility` | no | `games`: ids de juego o `"*"`; `runtimes`: por ahora `scratch-vm`. |
| `modifies` | no | Cosas que el mod cambia (texto libre). Si dos mods declaran lo mismo, Pitch avisa del conflicto. |
| `incompatibleWith` | no | Ids con los que no puede convivir. |

## Orden de carga, dependencias y conflictos

1. La base de Pitch carga siempre primero.
2. Después los mods por categoría: **framework → content → gameplay → balance**.
3. Dentro de una categoría manda el orden que el usuario pone en el gestor (↑ ↓).
4. Una **dependencia carga siempre antes** que quien la necesita, aunque eso cambie el orden por categoría.

Antes de abrir el juego Pitch comprueba que las dependencias estén instaladas, activadas y en una versión compatible, que no haya ciclos ni incompatibilidades declaradas, y que el mod sirva para ese juego. Si algo falla, no arranca con mods y te dice exactamente por qué (y te ofrece jugar sin mods). Los **conflictos** (dos mods que declaran `modifies` lo mismo, o que interceptan la misma función con `Pitch.patch`) son un aviso, no un error: prevalece el último en cargar.

Si un mod falla al cargar, los demás se cargan igualmente; los que dependían de él se saltan.

## Permisos y seguridad (leer)

Cada mod declara qué namespaces de `Pitch` necesita. La primera vez que se ejecuta (o cuando una actualización pide permisos nuevos) Pitch te los muestra y tienes que aprobarlos.

| Permiso | Da acceso a |
|---|---|
| `game` | `Pitch.game`, `sprites`, `variables`, `players`, `entities`, `events`, `patch` |
| `graphics` | `Pitch.assets` (imágenes y sonidos del juego) |
| `audio` | `Pitch.audio` |
| `storage` | `Pitch.storage` |
| `ui` | `Pitch.ui` |
| `input` | `Pitch.input` |
| `network` | `fetch`, `XMLHttpRequest`, `WebSocket` |

`system` (acceso al sistema) **está rechazado**.

**Esto no es un sandbox.** El código de un mod se ejecuta dentro de la página del propio juego. Los permisos controlan lo que la API de Pitch le ofrece (y evitan accesos accidentales), pero un mod malicioso podría saltárselos. Por eso Pitch lo dice claramente en pantalla: **instala solo mods de gente de confianza.** Lo que sí está garantizado por Pitch: un mod solo puede leer archivos de **su propia carpeta** (`Pitch.files`), no se instalan mods con enlaces simbólicos, y el juego original nunca se modifica.

## API

Todo está en el objeto global `Pitch` que recibe tu código. Las funciones asíncronas devuelven `Promise`.

### Siempre disponible

```js
Pitch.version                    // "1.0"
Pitch.mod                        // { id, name, version }
Pitch.log(...args)               // console.log con el prefijo del mod
Pitch.files.readJSON('data/enemies.json')   // también readText y read (ArrayBuffer)
```
`Pitch.files` solo lee dentro de la carpeta del mod.

### `game`

```js
Pitch.game.isRunning() / isPaused()
Pitch.game.pause() / resume()    // congela el bucle de fotogramas (los temporizadores de Scratch siguen contando)
Pitch.game.restart() / stop()
Pitch.game.stageSize()

Pitch.sprites.all() / find('Cat') / getById(id) / stage()
sprite.x, .y, .direction, .visible, .size, .name, .exists
sprite.setXY(x,y) .moveBy(dx,dy) .moveTowards(x,y,step) .distanceTo(x,y)
sprite.setDirection(d) .setSize(%) .show() .hide() .touching('Otro')
sprite.getVariable('vidas') / setVariable('vidas', 3)
sprite.setHealth(n) .getHealth() .heal(n) .damage(n) .setSpeed(n) .getSpeed()
sprite.data                      // objeto libre para tu estado
sprite.raw                       // el objeto interno de Scratch (RenderedTarget)

Pitch.variables.get('score') / set('score', 10)   // globales (o locales si no hay global)
```

### Crear contenido nuevo

```js
await Pitch.assets.register('zombie', 'assets/zombie.png');       // 'graphics'
const z = await Pitch.entities.create({
  id: 'zombie', sprite: 'zombie', x: 200, y: 0, health: 50, speed: 3, baseOn: 'Cat', data: {},
});
z.moveTowards(player.x, player.y, z.getSpeed());
z.damage(10);                    // dispara entityDamage y, al llegar a 0, entityDeath
z.delete();
Pitch.entities.all() / find('zombie')
```

`entities.create` **duplica un sprite existente del juego** (`baseOn`, o el primero) y le quita sus scripts: la entidad solo tiene la imagen y el comportamiento que le des desde tu mod. Si el proyecto no tiene ningún sprite, no se puede crear nada (es una limitación de Scratch).

### Assets

```js
Pitch.assets.replace('Cat', 'assets/cat-nuevo.png')      // cambia la imagen del disfraz actual, conservando su nombre
Pitch.assets.replace('Cat', 'assets/x.png', { costume: 'run' })
Pitch.assets.addSound('Cat', 'audio/boom.wav', 'boom')
Pitch.assets.replaceSound('Cat', 'boom', 'audio/boom2.wav')
```
Mantener el nombre del disfraz/sonido hace que los scripts del juego que lo usan sigan funcionando.

### Eventos (`Pitch.events.on(nombre, fn)` → devuelve la función para desuscribirse; también `once`)

| Evento | De dónde sale |
|---|---|
| `gameStart`, `gameEnd` | bandera verde / parar todo. **Se entrega también si te suscribes tarde** (`{ late: true }`), porque los mods suelen cargar datos antes de suscribirse. |
| `gamePause`, `gameResume` | los que provoca `Pitch.game.pause/resume` |
| `tick` | cada fotograma ejecutado (`{ dt }`) |
| `spriteCreated`, `spriteDeleted`, `cloneCreated`, `cloneDeleted` | eventos reales del runtime |
| `keyDown`, `keyUp`, `mouseDown`, `mouseUp` | entrada (incluida la del mando). `keyDown` trae `scratchKey` (`'left arrow'`, `'space'`…) |
| `broadcast` | mensajes de Scratch (`{ name }`) |
| `costumeChanged` | cambio de disfraz |
| `variableChanged` | **derivado**: Scratch no avisa, Pitch compara valores cada fotograma |
| `soundPlayed` | mejor esfuerzo: si el runtime no tiene banco de sonidos aún, no se emite |
| `entityCreated`, `entityDamage`, `entityDeath` | de `Pitch.entities` |
| `playerSpawn`, `playerMove`, `playerDamage`, `playerDeath` | **derivados**: Scratch no tiene el concepto de "jugador". Tú lo defines (ver abajo). |

### Jugador

```js
Pitch.players.define({ sprite: 'Cat', healthVariable: 'vidas', deathAt: 0 });
```
A partir de ahí Pitch emite `playerMove` (cambia la posición), `playerDamage` (la variable baja), `playerDeath` (llega a `deathAt`, una vez) y `playerSpawn` (aparece o se recupera).

### `Pitch.patch` — interceptar funciones internas

```js
const unpatch = Pitch.patch('Target.setXY', original => function (x, y, force) {
  return original.call(this, x * 2, y, force);
});
```
Espacios admitidos: `Target.*`, `Runtime.*`, `VM.*`, `Keyboard.*`, `Mouse.*`, con un método que exista. Son las funciones reales de `scratch-vm`, no una API inventada. Si dos mods interceptan lo mismo, Pitch avisa. Deshaz los parches en orden inverso al que los hiciste.

### `ui`

```js
const win = Pitch.ui.createWindow({ title: 'Mi mod', width: 400, height: 300 });
win.addText('Hola'); win.addButton('Pulsar', () => {}); win.addBar({ value: 40, max: 100 });
win.body            // elemento DOM por si quieres construir lo tuyo
Pitch.ui.text({ x: 12, y: 30, text: 'Oleada 1' });      // HUD sobre el juego
Pitch.ui.bar({ x: 12, y: 12, width: 160, max: 100, value: 100, color: '#ff6b7f' });
Pitch.ui.button({ text: 'OK', x: 10, y: 60, onClick() {} });
Pitch.ui.toast('Mensaje');
```
La interfaz vive en un Shadow DOM: no hereda ni rompe los estilos del juego.

### `audio`, `storage`, `input`

```js
await Pitch.audio.play('audio/boss.mp3', { volume: 0.5, loop: true });  // devuelve { stop(), setVolume() }
Pitch.audio.stopAll();

Pitch.storage.get('mejor') / set('mejor', 7) / remove('mejor')          // aislado por mod

Pitch.input.isKeyDown('ArrowLeft') / mouse() / gamepads()
```
Los navegadores bloquean el audio hasta que el jugador interactúa con la página; Pitch reintenta con la primera tecla o clic.

## Notas y límites conocidos

- Los mods se aplican **al abrir el juego desde Pitch**, no a uno que ya esté abierto. Pitch abre un puerto de depuración **solo local** (127.0.0.1, aleatorio) únicamente cuando hay mods activos o un mando conectado; en Vanilla sin mando no se abre nada.
- `Pitch.game.pause` congela fotogramas, pero los temporizadores de Scratch (`esperar`) siguen contando en tiempo real.
- Un mod no puede crear un juego de cero ni scripts de bloques nuevos: añade comportamiento en JavaScript sobre lo que el juego ya tiene.
- El código del mod debe ser un script normal (no módulos `import/export`).
