// Zombie Expansion — example Pitch mod.
// Edit data/config.json so playerSprite / healthVariable match the game you are modding.
Pitch.files.readJSON('data/config.json').then(async function (cfg) {
  await Pitch.assets.register('zombie', 'assets/zombie.png');

  var player = Pitch.players.define({ sprite: cfg.playerSprite, healthVariable: cfg.healthVariable });
  var best = Pitch.storage.get('bestWave') || 0;

  var healthBar = Pitch.ui.bar({ x: 12, y: 12, width: 160, max: cfg.startHealth, value: cfg.startHealth, color: '#ff6b7f' });
  var waveText = Pitch.ui.text({ x: 12, y: 30, text: 'Oleada 0 · mejor ' + best });

  var wave = 0;
  var zombies = [];
  var cooldown = 0;
  var spawning = false; // creating entities is asynchronous: without this, the next tick would start another wave on top

  async function spawnWave() {
    if (spawning) return;
    spawning = true;
    try {
      wave += 1;
      waveText.setText('Oleada ' + wave + ' · mejor ' + best);
      for (var i = 0; i < cfg.zombiesPerWave + wave - 1; i++) {
        var side = Math.random() < 0.5 ? -220 : 220;
        var z = await Pitch.entities.create({
          id: 'zombie', sprite: 'zombie', x: side, y: Math.round(Math.random() * 240 - 120),
          health: cfg.zombieHealth, speed: cfg.zombieSpeed,
        });
        z.setSize(60);
        zombies.push(z);
      }
      Pitch.audio.play('audio/groan.wav', { volume: 0.4 });
    } finally {
      spawning = false;
    }
  }

  Pitch.events.on('gameStart', function () { spawnWave(); });

  Pitch.events.on('tick', function (e) {
    cooldown = Math.max(0, cooldown - e.dt);
    zombies = zombies.filter(function (z) { return z.exists; });
    zombies.forEach(function (z) {
      z.moveTowards(player.x, player.y, z.getSpeed());
      if (cooldown === 0 && z.touching(player)) {
        player.setVariable(cfg.healthVariable, player.getVariable(cfg.healthVariable) - cfg.contactDamage);
        cooldown = 1;
      }
    });
    if (zombies.length === 0 && wave > 0 && !spawning) spawnWave();
  });

  Pitch.events.on('playerDamage', function (e) { healthBar.set(e.health); });
  Pitch.events.on('playerDeath', function () {
    if (wave > best) { best = wave; Pitch.storage.set('bestWave', best); }
    Pitch.ui.toast('Has caído en la oleada ' + wave);
    zombies.forEach(function (z) { z.delete(); });
    zombies = [];
    wave = 0;
  });
}).catch(function (e) { Pitch.log('error al iniciar:', e && e.message); throw e; });
