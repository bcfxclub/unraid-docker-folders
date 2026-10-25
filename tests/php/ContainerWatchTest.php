<?php

declare(strict_types=1);

require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/include/config.php';
require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/classes/ContainerWatch.php';

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;

/**
 * ContainerWatch::plan(), the once-a-minute sweep's rules: what counts as a
 * crash or a dark port, and when that sends a notification. Only the pure
 * half: run() needs a socket and /proc.
 */
final class ContainerWatchTest extends TestCase
{
    private const NOW = 1_800_000_000;
    private const STARTED = '2027-01-15T07:00:00.123456789Z';

    private static function listed(string $state, string $status, array $published = []): array
    {
        return [
            'Id' => 'pg',
            'Names' => ['/postgresql16'],
            'State' => $state,
            'Status' => $status,
            'Ports' => array_map(fn ($p) => ['PrivatePort' => 5432, 'PublicPort' => $p, 'Type' => 'tcp'], $published),
        ];
    }

    private static function seen(array $overrides = []): array
    {
        return array_merge([
            'running' => true,
            'startedAt' => self::STARTED,
            'finishedAt' => '0001-01-01T00:00:00Z',
            'exitCode' => 0,
            'oomKilled' => false,
            'networkMode' => 'bridge',
            'bindings' => [['containerPort' => 5432, 'hostPort' => 5432, 'type' => 'tcp']],
            'pidAlive' => true,
            'listening' => [5432],
            'publishesPorts' => true,
        ], $overrides);
    }

    private static function running(array $seen = [], array $published = [5432]): array
    {
        return ContainerWatch::observe(self::listed('running', 'Up 19 hours', $published), self::seen($seen));
    }

    /** Run the sweeps in order, a minute apart, and collect every notification. */
    private static function sweeps(array $observationsPerSweep, $prev = ['at' => self::NOW - 60, 'containers' => []]): array
    {
        $notify = [];
        $now = self::NOW;
        foreach ($observationsPerSweep as $observations) {
            $plan = ContainerWatch::plan($prev, $observations, $now);
            $notify = array_merge($notify, $plan['notify']);
            $prev = $plan['state'];
            $now += 60;
        }
        return ['state' => $prev, 'notify' => $notify];
    }

    #[Test]
    public function readsOnlyListeningSocketsFromProcNet(): void
    {
        $text = <<<'TXT'
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:1538 00000000:0000 0A 00000000:00000000 00:00000000 00000000   999        0 1 1
   1: 0100007F:1F90 0100007F:9C40 01 00000000:00000000 00:00000000 00000000   999        0 2 1
   0: 00000000000000000000000000000000:0050 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 3 1
TXT;
        $this->assertSame([80, 5432], ContainerWatch::listeningPorts($text));
    }

    #[Test]
    public function readsDockerTimesWithNineDigitFractionsAndTheZeroTime(): void
    {
        $this->assertSame(gmmktime(7, 0, 0, 1, 15, 2027), ContainerWatch::timestamp(self::STARTED));
        $this->assertSame(0, ContainerWatch::timestamp('0001-01-01T00:00:00Z'));
        $this->assertSame(0, ContainerWatch::timestamp(''));
    }

    #[Test]
    public function readsUptimeFromRunningStatusLines(): void
    {
        $this->assertSame(68400 + 1800, DockerClient::uptimeUpperBound('Up 19 hours (healthy)'));
        $this->assertSame(120, DockerClient::uptimeUpperBound('Up About a minute'));
        $this->assertNull(DockerClient::uptimeUpperBound('Exited (1) 2 hours ago'));
    }

    #[Test]
    public function flagsAProcessThatExitedWhileDockerSaysRunning(): void
    {
        $dead = self::running(['finishedAt' => '2027-01-15T07:43:00Z', 'exitCode' => 1]);
        $result = self::sweeps([[$dead], [$dead]]);

        $this->assertTrue($result['state']['containers']['pg']['processExited']);
        $this->assertCount(1, $result['notify'], 'once, not every minute');
        $this->assertSame('Container crashed: postgresql16', $result['notify'][0]['subject']);
        $this->assertSame(
            "postgresql16's process exited with code 1, but Docker still lists it as running.",
            $result['notify'][0]['description']
        );
    }

    #[Test]
    public function flagsARunningContainerWhosePidIsGoneWithNoExitCode(): void
    {
        $dead = self::running(['pidAlive' => false, 'listening' => null]);
        $result = self::sweeps([[$dead], [$dead]]);
        $this->assertTrue($result['state']['containers']['pg']['processExited']);
        $this->assertSame(
            "postgresql16's process exited, but Docker still lists it as running.",
            $result['notify'][0]['description'],
            'ExitCode is reset on start, so it says nothing here'
        );
    }

    #[Test]
    public function aRestartInProgressIsNotADeadProcess(): void
    {
        $restarting = self::running(['running' => false, 'pidAlive' => false, 'finishedAt' => '2027-01-15T07:43:00Z']);
        $plan = ContainerWatch::plan(null, [$restarting], self::NOW);
        $this->assertFalse($plan['state']['containers']['pg']['processExited']);
    }

    #[Test]
    public function aFinishedAtFromBeforeTheBootIsNotADeadProcess(): void
    {
        // A clock behind at boot: this run's StartedAt is older than the
        // FinishedAt the last shutdown wrote.
        $skewed = self::running(['finishedAt' => '2027-01-15T07:43:00Z']);
        $bootedAt = gmmktime(7, 50, 0, 1, 15, 2027);
        $plan = ContainerWatch::plan(null, [$skewed], self::NOW, $bootedAt);
        $this->assertFalse($plan['state']['containers']['pg']['processExited']);
    }

    #[Test]
    public function theFirstSweepOnlyRecordsAndTheNextOneNotifies(): void
    {
        $dead = self::running(['finishedAt' => '2027-01-15T07:43:00Z', 'exitCode' => 1]);
        $first = ContainerWatch::plan(null, [$dead], self::NOW);
        $this->assertSame([], $first['notify']);

        $second = ContainerWatch::plan($first['state'], [$dead], self::NOW + 60);
        $this->assertCount(1, $second['notify']);
    }

    #[Test]
    public function notifiesWhenARunningContainerCrashes(): void
    {
        $crashed = ContainerWatch::observe(self::listed('exited', 'Exited (1) 20 seconds ago'), self::seen(['running' => false, 'exitCode' => 1]));
        $result = self::sweeps([[self::running()], [$crashed]]);

        $this->assertCount(1, $result['notify']);
        $this->assertSame('postgresql16 exited with code 1.', $result['notify'][0]['description']);
    }

    #[Test]
    public function aStopDoesNotNotify(): void
    {
        $stopped = ContainerWatch::observe(self::listed('exited', 'Exited (143) 20 seconds ago'), self::seen(['running' => false, 'exitCode' => 143]));
        $this->assertSame([], self::sweeps([[self::running()], [$stopped]])['notify']);
    }

    #[Test]
    public function anOutOfMemoryKillNotifiesThoughItsCodeIsAStopCode(): void
    {
        $killed = ContainerWatch::observe(
            self::listed('exited', 'Exited (137) 20 seconds ago'),
            self::seen(['running' => false, 'exitCode' => 137, 'oomKilled' => true])
        );
        $result = self::sweeps([[self::running()], [$killed]]);
        $this->assertSame('postgresql16 was killed for running out of memory.', $result['notify'][0]['description']);
    }

    #[Test]
    public function notifiesACrashThatStartedAndEndedBetweenSweeps(): void
    {
        $before = ContainerWatch::observe(self::listed('exited', 'Exited (0) 3 days ago'), null);
        $brief = ContainerWatch::observe(
            self::listed('exited', 'Exited (1) 10 seconds ago'),
            self::seen(['running' => false, 'exitCode' => 1, 'finishedAt' => gmdate('Y-m-d\TH:i:s\Z', self::NOW + 50)])
        );
        $this->assertCount(1, self::sweeps([[$before], [$brief]])['notify']);
    }

    #[Test]
    public function aRestartLoopNotifiesOnceUntilTheContainerRunsCleanly(): void
    {
        $restarting = ContainerWatch::observe(self::listed('restarting', 'Restarting (1) 5 seconds ago'), self::seen(['running' => false, 'exitCode' => 1]));
        $justStarted = self::running(['startedAt' => gmdate('Y-m-d\TH:i:s\Z', self::NOW + 100)]);
        $result = self::sweeps([[self::running()], [$restarting], [$justStarted], [$restarting]]);
        $this->assertCount(1, $result['notify']);
    }

    #[Test]
    public function runningCleanlyForTenMinutesClearsTheEarlierCrash(): void
    {
        $prev = ['at' => self::NOW - 60, 'containers' => ['pg' => ['running' => false, 'startedAt' => '', 'alerted' => true]]];
        $plan = ContainerWatch::plan($prev, [self::running()], self::NOW);
        $this->assertFalse($plan['state']['containers']['pg']['alerted']);

        $recent = self::running(['startedAt' => gmdate('Y-m-d\TH:i:s\Z', self::NOW - 120)]);
        $plan = ContainerWatch::plan($prev, [$recent], self::NOW);
        $this->assertTrue($plan['state']['containers']['pg']['alerted']);
    }

    #[Test]
    public function aPortThatStopsListeningIsFlaggedOnTheSecondMiss(): void
    {
        $closed = self::running(['listening' => []]);
        $once = self::sweeps([[self::running()], [$closed]]);
        $this->assertSame([], $once['state']['containers']['pg']['closedPorts']);
        $this->assertSame([], $once['notify']);

        $twice = self::sweeps([[self::running()], [$closed], [$closed], [$closed]]);
        $this->assertSame([5432], $twice['state']['containers']['pg']['closedPorts']);
        $this->assertCount(1, $twice['notify']);
        $this->assertSame('postgresql16 is running, but nothing listens on port 5432.', $twice['notify'][0]['description']);
    }

    #[Test]
    public function aFlappingPortNotifiesOnceUntilItStaysQuiet(): void
    {
        $closed = self::running(['listening' => []]);
        $open = self::running();
        $flap = [[$open], [$closed], [$closed], [$open], [$closed], [$closed]];
        $this->assertCount(1, self::sweeps($flap)['notify']);

        $quiet = array_fill(0, (int) (ContainerWatch::RECOVERED_SECONDS / 60) + 1, [$open]);
        $again = array_merge([[$open], [$closed], [$closed]], $quiet, [[$closed], [$closed]]);
        $this->assertCount(2, self::sweeps($again)['notify']);
    }

    #[Test]
    public function aNetworkThatNeverPublishesPortsIsNotFlaggedUnpublished(): void
    {
        $macvlan = self::running(['networkMode' => 'br0', 'publishesPorts' => false], []);
        $result = self::sweeps([[$macvlan], [$macvlan]]);
        $this->assertSame([], $result['state']['containers']['pg']['unpublishedPorts']);
    }

    #[Test]
    public function aPortNeverSeenListeningIsNotFlagged(): void
    {
        $closed = self::running(['listening' => []]);
        $result = self::sweeps([[$closed], [$closed], [$closed]]);
        $this->assertSame([], $result['state']['containers']['pg']['closedPorts']);
        $this->assertSame([], $result['notify']);
    }

    #[Test]
    public function aHostPortDockerDidNotPublishIsFlaggedOnTheSecondMiss(): void
    {
        $unpublished = self::running([], []);
        $result = self::sweeps([[$unpublished], [$unpublished]]);
        $this->assertSame([5432], $result['state']['containers']['pg']['unpublishedPorts']);
        $this->assertSame('postgresql16 is running, but Docker has not published host port 5432.', $result['notify'][0]['description']);
    }

    #[Test]
    public function aRestartStartsThePortCountOver(): void
    {
        $closed = self::running(['listening' => []]);
        $restarted = self::running(['listening' => [], 'startedAt' => '2027-01-15T08:00:00Z']);
        $result = self::sweeps([[self::running()], [$closed], [$restarted]]);
        $this->assertSame([], $result['state']['containers']['pg']['closedPorts']);
    }

    #[Test]
    public function hostNetworkContainersAreNotPortChecked(): void
    {
        $host = self::running(['networkMode' => 'host', 'listening' => null], []);
        $result = self::sweeps([[$host], [$host]]);
        $this->assertSame([], $result['state']['containers']['pg']['unpublishedPorts']);
    }

    #[Test]
    public function annotateShowsOnlyFindingsForTheRunTheSweepSaw(): void
    {
        $sweep = ['at' => self::NOW - 30, 'containers' => ['pg' => [
            'running' => true, 'processExited' => true, 'closedPorts' => [5432], 'unpublishedPorts' => [],
        ]]];
        $listed = ['id' => 'pg', 'state' => 'running', 'status' => 'Up 19 hours'];

        $shown = ContainerWatch::annotate([$listed], $sweep, self::NOW)[0];
        $this->assertTrue($shown['processExited']);
        $this->assertSame([5432], $shown['closedPorts']);

        $restarted = ContainerWatch::annotate([['status' => 'Up 5 seconds'] + $listed], $sweep, self::NOW)[0];
        $this->assertFalse($restarted['processExited']);
        $this->assertSame([], $restarted['closedPorts']);

        $old = ['at' => self::NOW - ContainerWatch::SHOW_SECONDS - 1] + $sweep;
        $this->assertFalse(ContainerWatch::annotate([$listed], $old, self::NOW)[0]['processExited']);

        $none = ContainerWatch::annotate([$listed], null, self::NOW)[0];
        $this->assertFalse($none['processExited']);
    }

    #[Test]
    public function aStaleSweepIsNotLoaded(): void
    {
        $path = tempnam(sys_get_temp_dir(), 'watch');
        file_put_contents($path, json_encode(['at' => self::NOW - ContainerWatch::STALE_SECONDS - 1, 'containers' => []]));
        $this->assertNull(ContainerWatch::loadSweep($path, self::NOW));
        file_put_contents($path, json_encode(['at' => self::NOW - 60, 'containers' => []]));
        $this->assertNotNull(ContainerWatch::loadSweep($path, self::NOW));
        unlink($path);
    }
}
