# Pitch

Centro de juegos de escritorio para tus juegos de Scratch exportados como apps de **Windows, macOS y Linux**. Portada tipo streaming (destacados, filas por categoría), biblioteca, actualizaciones automáticas desde **Releases de GitHub**, integración con **Discord**, y un panel de **administración** para gestionar el catálogo sin tocar GitHub a mano.

## Probarlo

```bash
npm install
npm start
```

Necesitas Node 20 o superior. Los tests: `npm test`.

## Cómo se organizan los juegos en GitHub

1. **Un repositorio por juego**, con una *Release* por versión. Los archivos de la Release son los juegos exportados: `MiJuego-windows.zip`, `MiJuego-macos.zip`, `MiJuego-linux.zip` (opcionalmente con `-x64`/`-arm64`). También valen `.tar.gz` y `.AppImage`.

2. **Un repositorio de catálogo** con un `catalog.json` en la raíz. Ejemplo en [`catalog-example/catalog.json`](catalog-example/catalog.json):

```json
{
  "name": "Juegos de Roud",
  "games": [
    {
      "repo": "tu-usuario/space-cat",
      "title": "Space Cat",
      "description": "Un gato astronauta esquiva cometas.",
      "tags": ["arcade"],
      "cover": "https://raw.githubusercontent.com/tu-usuario/space-cat/main/cover.png",
      "banner": "https://raw.githubusercontent.com/tu-usuario/space-cat/main/banner.png",
      "featured": true
    }
  ]
}
```

Solo `repo` es obligatorio. Campos opcionales: `id`, `title`, `author`, `description`, `tags`, `cover` (carátula, https), `banner` (imagen ancha para la portada, https), `featured` (aparece en el carrusel principal), `channel` (`"prerelease"` para seguir pre-releases) y `assets` (regex por sistema si tus nombres no siguen la convención).

En Pitch: **Ajustes → Catálogo**, escribe `tu-usuario/pitch-catalog`. También puedes fijar un catálogo de fábrica en `pitch.config.json` (ver más abajo) para que la app ya venga configurada.

## Panel de Administración

Si el token de GitHub guardado en Ajustes tiene permiso de **escritura** sobre el repositorio del catálogo, aparece una pestaña **Administración** en la barra superior. Desde ahí, sin salir de Pitch:

- Añadir, editar y quitar juegos con un formulario (no hace falta escribir JSON a mano).
- Activar/desactivar qué juegos son "Destacados" (aparecen en el carrusel de portada).
- Los cambios quedan en un borrador local hasta que pulsas **Publicar**, que hace un commit real a `catalog.json` en GitHub. **Descartar** vuelve a la última versión publicada.
- Si alguien más publicó cambios mientras editabas, Pitch avisa del conflicto en vez de sobrescribirlos a ciegas.

## Cómo se actualizan los juegos

Igual que antes: Pitch consulta la última Release de cada juego (al abrir, cada 30 min configurable, y al volver de suspensión), descarga con verificación SHA-256, y sustituye la versión anterior solo si la nueva se instaló entera. Desactivable en Ajustes.

## Discord

En **Ajustes → Discord** (necesita que la compilación tenga configurada una app de Discord, ver abajo):

- **Vincular cuenta**: abre el flujo de autorización de Discord en tu navegador. Pitch nunca ve tu contraseña, solo recibe un permiso limitado a leer tu perfil y, si esta app tiene el permiso aprobado por Discord, tu lista de amigos.
- **Presencia enriquecida (Rich Presence)**: mientras juegas, tu perfil de Discord muestra "Jugando a `<juego>`", visible para tus amigos.
- **Amigos conectados**: si el permiso está aprobado, verás qué amigos están en línea y a qué están jugando ellos.
- **Abrir llamada** (botón *Abrir Discord* de Ajustes): trae al frente la app de escritorio de Discord, o la abre. Es independiente del panel lateral de más abajo.

> **Importante sobre la lista de amigos**: leerla requiere el permiso `relationships.read` de Discord, que **Discord aprueba caso por caso** para cada aplicación (no es automático). **Por defecto Pitch no lo pide** — si lo pidiera sin tenerlo aprobado, Discord rechazaría la vinculación entera con un error `invalid_scope`, y ni siquiera el perfil ni la presencia funcionarían. Mientras tu app no tenga ese permiso aprobado, deja `discordRequestFriendsScope` en `false` (el valor por defecto) en `pitch.config.json`; así Pitch pide solo `identify` y todo lo demás (perfil, presencia, abrir la llamada) funciona con normalidad, solo sin la lista de amigos. El día que Discord te apruebe `relationships.read` para esta aplicación, cambia ese valor a `true`.

### Configurar tu app de Discord

1. Crea una aplicación gratis en https://discord.com/developers/applications
2. En **OAuth2**, copia el **Client ID**, añade como *Redirect* `http://127.0.0.1:28914/callback` (Pitch abre un servidor local temporal solo durante el login) y **activa "Public Client"** (guarda los cambios). No hace falta el Client Secret.
3. Pon el Client ID en `pitch.config.json`:

```json
{
  "catalog": "tu-usuario/pitch-catalog",
  "discordClientId": "TU_CLIENT_ID",
  "discordRequestFriendsScope": false
}
```

Sin esto, la sección de Discord sigue existiendo pero se mantiene desactivada con un aviso, en vez de romperse.

> **Por qué no hay secret**: `pitch.config.json` viaja dentro de la app y cualquiera puede desempaquetarla, así que un secret ahí no sería secreto. Pitch inicia sesión con **PKCE** (RFC 7636): genera una clave de un solo uso en cada vinculación y Discord la verifica, sin ningún secreto compartido. Si Discord responde que la app no es un cliente público, es que falta activar *Public Client* en el paso 2.

## Discord dentro de Pitch (panel lateral)

El botón de **Discord** de la barra superior abre el cliente web de Discord **a un lado de Pitch**, como el panel lateral de Opera GX. No es un iframe (Discord no permite que lo incrusten así), sino una vista web independiente con su propia sesión: inicias sesión una vez y se recuerda, y **una llamada no se corta al ocultar el panel**.

- **Llamada**: el botón del teléfono abre el panel en el canal de voz (o chat privado) que elijas en *Ajustes → Discord en el panel lateral* (pega el enlace del canal: clic derecho en Discord → *Copiar enlace*). Unirte a la llamada depende de Discord y puede pedirte un clic.
- **Micrófono**: solo se concede a las páginas de Discord; cualquier otro permiso se deniega. En macOS te lo pedirá el sistema la primera vez.
- **Seguridad**: sesión aislada de la de Pitch, navegación limitada a Discord (los demás enlaces se abren en tu navegador) y sin acceso a Node.
- **Cerrar sesión del panel**: en Ajustes; borra la sesión guardada y corta cualquier llamada.
- Mientras juegas, Pitch se oculta (y con él el panel), pero el audio de la llamada sigue.

> No verificado contra el Discord real: las pruebas se hicieron en un entorno sin acceso a discord.com. Probado: acoplado, permisos, aislamiento, ocultar/mostrar sin destruir la página, cerrar sesión. Si Discord cambia su comportamiento con clientes embebidos, puede pedir pasos extra al iniciar sesión.

## Mods

Pitch puede aplicar **mods a juegos de Scratch exportados sin modificar el juego original**: al pulsar *Jugar*, abre el juego, entra en él y carga los mods **en memoria**. Cerrar el juego los quita; desinstalar o desactivar un mod basta.

En la página de cada juego, bloque **Mods**: instalar (carpeta o `.zip`), **perfiles** (Vanilla, Survival, Chaos…), activar/desactivar, **orden de carga** (↑ ↓), permisos, dependencias y avisos de conflicto. Antes de abrir el juego Pitch comprueba dependencias, versiones, incompatibilidades y pide aprobar los permisos la primera vez.

Un mod puede crear **contenido nuevo** (entidades con su propia imagen, sonidos, HUD y ventanas), reemplazar imágenes y sonidos, reaccionar a eventos del juego e interceptar funciones internas del runtime. Todo con una API estable (`Pitch.*`) que oculta las diferencias entre versiones de Scratch.

- **Guía para hacer mods**: [`docs/MODDING.md`](docs/MODDING.md)
- **Ejemplo completo** (zombis, oleadas, HUD, sonido): [`mods-example/zombie-expansion`](mods-example/zombie-expansion). Instálalo con *Instalar mod (carpeta)*.
- **Notas de investigación** (qué se verificó contra el runtime real y qué no): [`docs/mod-research.md`](docs/mod-research.md)

Qué tener claro:

- **Funciona con juegos de Scratch/TurboWarp exportados como app Chromium** (Electron o NW.js, lo que genera el TurboWarp Packager). Si Pitch no puede entrar en un juego, lo abre **sin mods** y te avisa.
- Para entrar, Pitch abre un **puerto de depuración solo local** (127.0.0.1, aleatorio) **únicamente** cuando hay mods activos o un mando conectado. En Vanilla sin mando no se abre nada.
- **Los permisos no son un sandbox**: el código del mod corre dentro del juego. Controlan lo que la API de Pitch ofrece, pero un mod malicioso podría saltárselos. Instala solo mods de gente de confianza. Un mod solo puede leer archivos de su propia carpeta.
- Los mods se aplican al abrir el juego **desde Pitch**, no a uno ya abierto.

## Mando

Si Pitch detecta un mando, los juegos que abras desde Pitch lo reciben **como si fuera el teclado**: stick izquierdo y cruceta → flechas (o WASD) y cada botón → la tecla que elijas (*Ajustes → Mando*). Es una traducción, no una integración nativa: los juegos de Scratch leen teclas, así que no hay que modificarlos.

- Si conectas el mando **después** de abrir un juego, ciérralo y ábrelo otra vez.
- Funciona en los mismos juegos que los mods (Scratch/TurboWarp como app Chromium).
- Probado con un mando simulado contra el teclado real del runtime; no con un mando físico.

## Pitch como centro del ordenador

- **Ajustes → Inicio del sistema → "Abrir Pitch al encender el ordenador"**: Pitch arranca en segundo plano con la sesión (usa el mecanismo nativo de cada sistema: registro de inicio de Windows, Elementos de inicio de macOS, autostart de XDG en Linux).
- **Accesos directos**: en la página de cualquier juego instalado, "Crear acceso directo" genera un `.lnk` (Windows), un `.app` (macOS) o un `.desktop` (Linux) que abre ese juego directamente, sin pasar por la portada.
- **Al pulsar Jugar**: Pitch se oculta y aparece una ventanita de carga (estilo Steam) con la carátula del juego y una barra de progreso, hasta que el juego termina de arrancar. Al cerrar el juego, Pitch vuelve a aparecer solo.

## Tema

**Ajustes → Tema**, o el interruptor rápido de la barra superior: **Azul y blanco** o **Azul y negro**. Se recuerda entre sesiones.

## Crear los instaladores de Pitch

```bash
npm run dist          # el sistema donde estás
npm run dist:win      # Windows (.exe instalador + zip)
npm run dist:mac      # macOS (.dmg + zip, x64 y arm64)
npm run dist:linux    # Linux (.AppImage + .deb)
```

Súbelo a GitHub y crea una etiqueta (`git tag v0.1.0 && git push --tags`): el workflow en [`.github/workflows/build.yml`](.github/workflows/build.yml) compila los tres sistemas y adjunta los instaladores a la Release.

## Notas por sistema

- **macOS**: sin firmar, la primera vez abre Pitch con clic derecho → Abrir. Pitch quita la cuarentena a los juegos que instala.
- **Linux**: los juegos Electron suelen necesitar `--no-sandbox`; Pitch lo añade si está activado en Ajustes. El auto-arranque usa `~/.config/autostart/`.
- **Windows**: SmartScreen puede avisar con el instalador de Pitch si no está firmado.

## Estructura

```
src/main/        proceso principal: GitHub, instalación, lanzador, biblioteca,
                 Discord (IPC + OAuth + panel lateral), auto-arranque, accesos directos, splash
src/main/mods/   sistema de mods: manifiesto, dependencias y orden de carga, almacén y perfiles,
                 injector (CDP), adaptadores de runtime, host y servicio
src/main/mods/page/   código que corre DENTRO del juego: núcleo de la API, UI de mods, traductor de mando
src/preload/     puente seguro con la interfaz
src/renderer/    interfaz: portada, biblioteca, detalle de juego (con mods), ajustes, administración
docs/            MODDING.md (guía de mods) y mod-research.md (investigación)
mods-example/    mod de ejemplo completo
test/            tests con node:test: GitHub simulado, Discord simulado y, en test/integration,
                 un Chromium real con el motor de TurboWarp (se omite si no hay Chromium)
```

Para ejecutar también los tests de integración: `PITCH_CHROMIUM=/ruta/a/chrome npm test`.

Tipografía: Bricolage Grotesque (SIL OFL, ver `src/renderer/fonts/OFL-LICENSE.txt`). Logo e icono proporcionados por el usuario.

## Actualizaciones de Pitch

Pitch busca versiones nuevas de sí mismo en las **GitHub Releases** de `planeador4000-design/pitch` (configurado en `build.publish` de `package.json`): 10 segundos después de abrir y luego cada 4 horas. También hay un botón en **Ajustes → Actualizaciones de Pitch**. Si hay una versión nueva, se descarga sola en segundo plano y se instala al cerrar Pitch (o al pulsar *Reiniciar y actualizar*). Esto es independiente de las actualizaciones de los juegos.

**Publicar una versión**: sube los cambios y crea una etiqueta:

```bash
git tag v0.2.0
git push origin v0.2.0
```

El workflow compila Windows, macOS y Linux, pone la versión de la etiqueta en la app y publica los instaladores junto con los archivos `latest*.yml` que las copias instaladas leen para saber que hay novedades. La versión nueva tiene que ser **mayor** que la instalada.

| Sistema | Qué pasa |
| --- | --- |
| Windows (instalador `.exe`) | Automático. |
| Linux (`.AppImage`) | Automático. |
| Linux (`.deb`) | Solo aviso con enlace de descarga (lo gestiona el gestor de paquetes). |
| macOS | **Solo aviso con enlace**, porque macOS únicamente deja que una app se reemplace a sí misma si está firmada con un certificado de Apple Developer. Cuando firmes las builds, pon `"macAutoUpdate": true` en `pitch.config.json`. |

Requisitos y límites:

- El repositorio `planeador4000-design/pitch` debe ser **público**: las copias instaladas leen las releases sin credenciales. Con un repo privado habría que repartir un token dentro de la app, que es justo lo que se quiere evitar.
- Solo comprueba la app **instalada** (empaquetada). `npm start` no actualiza nada. `PITCH_NO_SELF_UPDATE=1` lo desactiva.
- Windows puede mostrar el aviso de SmartScreen en instaladores sin firmar; no impide la actualización.
