<?php
/**
 * Unraid Docker Folders - container watch
 *
 * A once-a-minute sweep for failures Docker's own list does not show, and an
 * Unraid notification when a container dies. run-schedules.php calls run()
 * from cron. The plugin's ContainerWatchService is the GraphQL-mode copy.
 *
 * What it looks for, on each running container:
 *
 * - The process exited while Docker still lists the container as running.
 *   On tower a database showed "Up 19 hours" for 12 hours after its process
 *   exited with 1, and no status rule could see it. Inspect still said
 *   Running, but its FinishedAt was after its StartedAt. A FinishedAt from
 *   before the host booted does not count: a clock that was behind at boot
 *   gives a StartedAt older than the last shutdown's FinishedAt.
 * - A port the container published that nothing inside it listens on any
 *   more. Read from /proc/<pid>/net/tcp, the container's own network
 *   namespace, so no connection is made: a TCP probe makes some apps log an
 *   error every minute (Postgres logs "incomplete startup packet"), and a
 *   probe of the host port is answered by docker-proxy even when the app
 *   behind it is dead. Only a port seen listening during this run counts,
 *   so a port the app never opens does not raise a flag that never clears.
 * - A host port the container asks for that Docker has not published. After
 *   the tower fix the database ran with no network, and 5432 was gone. Only
 *   on a network that publishes ports at all: macvlan, ipvlan, host and none
 *   keep the bindings but never publish them (AdoptBuilder::UNPUBLISHED_PORT_DRIVERS).
 *
 * Port problems must show on two sweeps in a row, so a restart or a slow
 * listener does not raise one. Each kind of problem notifies once, and again
 * only after RECOVERED_SECONDS without it, so a restart loop or a flapping
 * port sends one notification. The first sweep after a reboot, or after the
 * plugin hands the work back, only records: it has no earlier sweep to
 * compare with.
 *
 * @package UnraidDockerModern
 */

require_once dirname(__DIR__) . '/include/config.php';
require_once __DIR__ . '/DockerClient.php';
require_once __DIR__ . '/AdoptBuilder.php';

class ContainerWatch
{
  /** In RAM, so a reboot starts over. containers.php reads it. */
  const STATE_PATH = '/var/run/' . PLUGIN_NAME . '.container-watch.json';
  const LOCK_PATH = '/tmp/unraid-docker-container-watch.lock';
  /** An older sweep is not compared with: cron or the runner has stopped. */
  const STALE_SECONDS = 180;
  /**
   * An older sweep is not shown. Tighter than STALE_SECONDS, because the
   * list tells a restart since the sweep only by the "Up" age, and that is
   * exact to the second only under a minute.
   */
  const SHOW_SECONDS = 90;
  /** A second process in the same minute (after a long backup) skips. */
  const MIN_INTERVAL = 30;
  /** This long without a problem clears an earlier notification. */
  const RECOVERED_SECONDS = 600;
  /** An exit this recent is inspected, so a crash between sweeps is seen. */
  const FRESH_EXIT_SECONDS = 120;
  /**
   * The exit codes a stop gives. The same set as STOP_EXIT_CODES in the
   * frontend's containerDisplay.ts and the plugin's container-watch.ts.
   */
  const STOP_EXIT_CODES = [0, 130, 131, 137, 143];

  /** The job name in the plugin runner's heartbeat file. */
  const JOB = 'container-watch';

  public static function run()
  {
    if (!file_exists(DOCKER_SOCKET) || dfmPluginRunnerOwns(self::JOB)) {
      return;
    }
    $fp = @fopen(self::LOCK_PATH, 'w');
    if (!$fp || !flock($fp, LOCK_EX | LOCK_NB)) {
      return;
    }
    try {
      $now = time();
      $prev = self::loadSweep(self::STATE_PATH, $now);
      if ($prev !== null && $now - (int) $prev['at'] < self::MIN_INTERVAL) {
        return;
      }

      $docker = new DockerClient();
      $listed = $docker->listContainersRaw();
      if ($listed === null) {
        return;
      }

      $inspects = $docker->inspectMany(self::idsToInspect($listed, $prev));
      $drivers = [];
      $observations = [];
      foreach ($listed as $container) {
        $inspect = $inspects[(string) ($container['Id'] ?? '')] ?? null;
        $observations[] = self::observe($container, is_array($inspect) ? self::readInspect($inspect, $docker, $drivers) : null);
      }

      $uptime = (float) @file_get_contents('/proc/uptime');
      $plan = self::plan($prev, $observations, $now, $uptime > 0 ? (int) ($now - $uptime) : 0);
      self::saveSweep($plan['state']);
      foreach ($plan['notify'] as $text) {
        sendUnraidNotification($text['subject'], $text['description'], 'warning');
      }
    } finally {
      flock($fp, LOCK_UN);
      fclose($fp);
    }
  }

  /**
   * The saved sweep, or null when there is none worth comparing with: none
   * yet, unreadable, or older than STALE_SECONDS.
   */
  public static function loadSweep($path, $now)
  {
    $data = @file_get_contents($path);
    $sweep = $data === false ? null : json_decode($data, true);
    if (!is_array($sweep) || !isset($sweep['at'], $sweep['containers']) || !is_array($sweep['containers'])) {
      return null;
    }
    return $now - (int) $sweep['at'] > self::STALE_SECONDS ? null : $sweep;
  }

  private static function saveSweep(array $sweep)
  {
    $tmp = self::STATE_PATH . '.tmp.' . getmypid();
    if (@file_put_contents($tmp, json_encode($sweep)) !== false) {
      @rename($tmp, self::STATE_PATH);
    }
  }

  /**
   * Running now, running at the last sweep, or exited within
   * FRESH_EXIT_SECONDS. Every other container is exited and was before.
   */
  public static function idsToInspect(array $listed, $prev)
  {
    $ids = [];
    foreach ($listed as $container) {
      $id = (string) ($container['Id'] ?? '');
      if ($id === '') continue;
      if (($container['State'] ?? '') === 'running' || !empty($prev['containers'][$id]['running'])) {
        $ids[] = $id;
        continue;
      }
      $age = DockerClient::statusAgeUpperBound((string) ($container['Status'] ?? ''));
      if ($age !== null && $age <= self::FRESH_EXIT_SECONDS) $ids[] = $id;
    }
    return $ids;
  }

  /**
   * The inspect fields the sweep reads, plus what /proc and the network say.
   * Those are the only parts that are not pure.
   *
   * @param array $drivers network mode => driver, filled as it goes
   */
  private static function readInspect(array $inspect, DockerClient $docker, array &$drivers)
  {
    $seen = self::fromInspect($inspect);
    $pid = (int) ($inspect['State']['Pid'] ?? 0);
    $seen['pidAlive'] = $pid > 0 && is_dir("/proc/{$pid}");
    $seen['listening'] = null;
    $seen['publishesPorts'] = false;
    if (!$seen['running'] || !self::checksPorts($seen['networkMode']) || empty($seen['bindings'])) {
      return $seen;
    }

    $mode = $seen['networkMode'] === 'default' ? 'bridge' : $seen['networkMode'];
    if (!array_key_exists($mode, $drivers)) $drivers[$mode] = $docker->getNetworkDriver($mode);
    // An unknown driver says nothing either way, so it is not checked.
    $seen['publishesPorts'] = $drivers[$mode] !== '' && AdoptBuilder::publishesPorts($mode, $drivers[$mode]);

    if ($seen['pidAlive'] && in_array('tcp', array_column($seen['bindings'], 'type'), true)) {
      $text = '';
      foreach (['tcp', 'tcp6'] as $file) {
        $text .= (string) @file_get_contents("/proc/{$pid}/net/{$file}");
      }
      $seen['listening'] = $text === '' ? null : self::listeningPorts($text);
    }
    return $seen;
  }

  /** The pure part of readInspect(). */
  public static function fromInspect(array $inspect)
  {
    $state = is_array($inspect['State'] ?? null) ? $inspect['State'] : [];
    return [
      // Mid-restart, Docker reports Running with no pid and a fresh
      // FinishedAt, which would read as a dead process.
      'running' => !empty($state['Running']) && empty($state['Restarting']),
      'startedAt' => (string) ($state['StartedAt'] ?? ''),
      'finishedAt' => (string) ($state['FinishedAt'] ?? ''),
      'exitCode' => (int) ($state['ExitCode'] ?? 0),
      'oomKilled' => !empty($state['OOMKilled']),
      'networkMode' => (string) ($inspect['HostConfig']['NetworkMode'] ?? ''),
      'bindings' => DockerClient::parsePortBindings($inspect['HostConfig']['PortBindings'] ?? []),
    ];
  }

  /**
   * A container on the host's network, or on another container's, has no
   * ports of its own: bindings are ignored and the sockets are not its own.
   */
  public static function checksPorts($networkMode)
  {
    return $networkMode !== 'host' && strpos((string) $networkMode, 'container:') !== 0;
  }

  /** The local ports in LISTEN state in /proc/net/tcp or tcp6 text. */
  public static function listeningPorts($text)
  {
    preg_match_all('/^\s*\d+:\s+[0-9A-Fa-f]+:([0-9A-Fa-f]{4})\s+[0-9A-Fa-f]+:[0-9A-Fa-f]{4}\s+0A\s/m', (string) $text, $m);
    $ports = array_values(array_unique(array_map('hexdec', $m[1])));
    sort($ports);
    return $ports;
  }

  /** One listed container, with what inspect and /proc said, or null. */
  public static function observe(array $listed, $inspect)
  {
    $published = [];
    foreach ((array) ($listed['Ports'] ?? []) as $port) {
      if (isset($port['PublicPort'])) $published[] = (int) $port['PublicPort'];
    }
    return [
      'id' => (string) ($listed['Id'] ?? ''),
      'name' => ltrim((string) ($listed['Names'][0] ?? ''), '/'),
      'state' => (string) ($listed['State'] ?? ''),
      'status' => (string) ($listed['Status'] ?? ''),
      'published' => array_values(array_unique($published)),
      'inspect' => $inspect,
    ];
  }

  /**
   * Docker's RFC 3339 time in epoch seconds, or 0 for its zero time and for
   * anything unreadable. The fraction is dropped first: Docker writes nine
   * digits, which strtotime() does not take.
   */
  public static function timestamp($value)
  {
    $ts = strtotime((string) preg_replace('/\.\d+/', '', (string) $value));
    return $ts !== false && $ts > 0 ? $ts : 0;
  }

  /**
   * The next sweep's state, and the notifications to send. Pure.
   *
   * @param array|null $prev         loadSweep(), null to only record
   * @param array      $observations observe() for every listed container
   * @param int        $now
   * @param int        $bootedAt     When the host booted, 0 when unknown
   * @return array {state: {at, containers: id => entry}, notify: {subject, description}[]}
   */
  public static function plan($prev, array $observations, $now, $bootedAt = 0)
  {
    $containers = [];
    $notify = [];
    foreach ($observations as $obs) {
      $id = $obs['id'];
      if ($id === '') continue;
      $was = $prev['containers'][$id] ?? null;
      $seen = $obs['inspect'];
      // An inspect that failed says nothing new. Keep what the last sweep
      // knew, so one failure does not forget the ports seen open.
      if ($seen === null && $obs['state'] === 'running' && !empty($was['running'])) {
        $containers[$id] = $was;
        continue;
      }
      $entry = [
        'name' => $obs['name'],
        'running' => $obs['state'] === 'running',
        'startedAt' => $seen['startedAt'] ?? ($was['startedAt'] ?? ''),
        'alerted' => !empty($was['alerted']),
        'portAlerted' => !empty($was['portAlerted']),
        'portQuietSince' => $was['portQuietSince'] ?? null,
        'open' => [],
        'closedNow' => [],
        'unpublishedNow' => [],
        'processExited' => false,
        'closedPorts' => [],
        'unpublishedPorts' => [],
      ];

      if ($entry['running'] && $seen !== null) {
        $started = self::timestamp($seen['startedAt']);
        $finished = self::timestamp($seen['finishedAt']);
        $finishedThisRun = $started > 0 && $finished > $started && $finished > $bootedAt;
        $entry['processExited'] = $seen['running'] && (!$seen['pidAlive'] || $finishedThisRun);

        $sameRun = $was !== null && !empty($was['running']) && ($was['startedAt'] ?? '') === $seen['startedAt'];
        if (!$entry['processExited'] && self::checksPorts($seen['networkMode'])) {
          $tcp = [];
          $hostPorts = [];
          foreach ($seen['bindings'] as $binding) {
            if ($binding['type'] === 'tcp') $tcp[] = $binding['containerPort'];
            $hostPorts[] = $binding['hostPort'];
          }
          $tcp = array_values(array_unique($tcp));
          $open = $sameRun ? (array) ($was['open'] ?? []) : [];
          if ($seen['listening'] !== null) {
            $open = array_values(array_unique(array_merge($open, array_intersect($tcp, $seen['listening']))));
            sort($open);
            $entry['closedNow'] = array_values(array_diff($open, $seen['listening']));
          }
          $entry['open'] = $open;
          if ($seen['publishesPorts']) {
            $entry['unpublishedNow'] = array_values(array_unique(array_diff($hostPorts, $obs['published'])));
          }
          if ($sameRun) {
            $entry['closedPorts'] = array_values(array_intersect($entry['closedNow'], (array) ($was['closedNow'] ?? [])));
            $entry['unpublishedPorts'] = array_values(array_intersect($entry['unpublishedNow'], (array) ($was['unpublishedNow'] ?? [])));
          }
        }

        // Two misses need an earlier sweep, so a problem implies $prev.
        if (!empty($entry['closedPorts']) || !empty($entry['unpublishedPorts'])) {
          $entry['portQuietSince'] = null;
          if (!$entry['portAlerted']) {
            $notify[] = self::portText($obs['name'], $entry['closedPorts'], $entry['unpublishedPorts']);
            $entry['portAlerted'] = true;
          }
        } elseif ($entry['portAlerted']) {
          $entry['portQuietSince'] = $entry['portQuietSince'] ?? $now;
          if ($now - $entry['portQuietSince'] >= self::RECOVERED_SECONDS) {
            $entry['portAlerted'] = false;
            $entry['portQuietSince'] = null;
          }
        }

        if ($entry['processExited']) {
          if ($prev !== null && !$entry['alerted']) {
            // ExitCode is reset on start, so it is the dead process's only
            // when FinishedAt shows this run ended.
            $notify[] = self::crashText($obs['name'], 'running', $finishedThisRun ? $seen['exitCode'] : null, false);
            $entry['alerted'] = true;
          }
        } elseif ($started > 0 && $now - $started >= self::RECOVERED_SECONDS) {
          $entry['alerted'] = false;
        }
      } elseif (!$entry['running']) {
        $code = $seen !== null ? $seen['exitCode'] : self::listedExitCode($obs['status']);
        $oom = $seen !== null && $seen['oomKilled'];
        $crashed = $obs['state'] === 'dead' || $obs['state'] === 'restarting'
          || ($obs['state'] === 'exited' && $code !== null && ($oom || !in_array($code, self::STOP_EXIT_CODES, true)));
        // Running at the last sweep, or exited since it: a container that
        // crashed within a minute of a start was never seen running.
        $sinceLast = $prev !== null
          && (!empty($was['running']) || ($seen !== null && self::timestamp($seen['finishedAt']) > (int) $prev['at']));
        if ($crashed && $sinceLast && !$entry['alerted']) {
          $notify[] = self::crashText($obs['name'], $obs['state'], $code, $oom);
          $entry['alerted'] = true;
        }
      }

      $containers[$id] = $entry;
    }
    return ['state' => ['at' => $now, 'containers' => $containers], 'notify' => $notify];
  }

  private static function listedExitCode($status)
  {
    return preg_match('/^(?:Exited|Restarting) \((-?\d+)\)/', (string) $status, $m) ? (int) $m[1] : null;
  }

  /** The notification for a crash. The plugin's crashText() writes the same. */
  public static function crashText($name, $state, $code, $oom)
  {
    if ($state === 'running') {
      $how = $code === null ? 'exited' : "exited with code {$code}";
      $description = "{$name}'s process {$how}, but Docker still lists it as running.";
    } elseif ($state === 'dead') {
      $description = "Docker reports {$name} as dead.";
    } elseif ($oom) {
      $description = "{$name} was killed for running out of memory.";
    } elseif ($state === 'restarting') {
      $description = "{$name} exited with code {$code} and is restarting.";
    } else {
      $description = "{$name} exited with code {$code}.";
    }
    return ['subject' => "Container crashed: {$name}", 'description' => $description];
  }

  /** The notification for port problems. The plugin's portText() writes the same. */
  public static function portText($name, array $closed, array $unpublished)
  {
    $parts = [];
    if ($closed) $parts[] = 'nothing listens on ' . self::portList('port', $closed);
    if ($unpublished) $parts[] = 'Docker has not published ' . self::portList('host port', $unpublished);
    return [
      'subject' => "Container unreachable: {$name}",
      'description' => "{$name} is running, but " . implode(' and ', $parts) . '.',
    ];
  }

  private static function portList($noun, array $ports)
  {
    return (count($ports) === 1 ? $noun : $noun . 's') . ' ' . implode(', ', $ports);
  }

  /**
   * The sweep's findings on each listed container, for containers.php. Only
   * from a sweep under SHOW_SECONDS old, and only for a container still
   * running the run the sweep saw: one started after the sweep has an uptime
   * shorter than the time since it.
   *
   * @param array      $containers DockerClient::listContainers() output
   * @param array|null $sweep      loadSweep()
   * @param int        $now
   * @return array The containers, each with processExited, closedPorts and unpublishedPorts
   */
  public static function annotate(array $containers, $sweep, $now)
  {
    $fresh = is_array($sweep) && $now - (int) $sweep['at'] <= self::SHOW_SECONDS;
    foreach ($containers as &$container) {
      $entry = $fresh ? ($sweep['containers'][$container['id']] ?? null) : null;
      $current = is_array($entry) && !empty($entry['running']) && ($container['state'] ?? '') === 'running';
      if ($current) {
        $uptime = DockerClient::uptimeUpperBound((string) ($container['status'] ?? ''));
        $current = $uptime !== null && $uptime >= $now - (int) $sweep['at'];
      }
      $container['processExited'] = $current && !empty($entry['processExited']);
      $container['closedPorts'] = $current ? array_values((array) $entry['closedPorts']) : [];
      $container['unpublishedPorts'] = $current ? array_values((array) $entry['unpublishedPorts']) : [];
    }
    unset($container);
    return $containers;
  }
}
