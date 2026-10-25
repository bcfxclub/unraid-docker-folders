<?php

declare(strict_types=1);

if (!defined('DOCKER_SOCKET')) {
    define('DOCKER_SOCKET', '/var/run/docker.sock');
}
if (!defined('DOCKER_API_VERSION')) {
    define('DOCKER_API_VERSION', 'v1.41');
}

require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/classes/DockerClient.php';

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;

/**
 * getLastErrorReason() is the text a failed container action shows the user,
 * so it must give Docker's own reason without request()'s HTTP prefix.
 */
final class DockerClientErrorReasonTest extends TestCase
{
    private function clientWithError(string $error, string $reason = ''): DockerClient
    {
        $client = new DockerClient('/nonexistent.sock');
        (new ReflectionProperty(DockerClient::class, 'lastError'))->setValue($client, $error);
        (new ReflectionProperty(DockerClient::class, 'lastErrorReason'))->setValue($client, $reason);
        return $client;
    }

    #[Test]
    public function givesDockersReasonWithoutTheHttpPrefix(): void
    {
        $reason = 'failed to set up container networking: endpoint with name postgresql16 already exists in network bridge';
        $client = $this->clientWithError("Docker API HTTP 500: {$reason}", $reason);
        $this->assertSame($reason, $client->getLastErrorReason());
    }

    #[Test]
    public function fallsBackToTheErrorWhenDockerGaveNoMessage(): void
    {
        $client = $this->clientWithError('Docker socket not found: /nonexistent.sock');
        $this->assertSame('Docker socket not found: /nonexistent.sock', $client->getLastErrorReason());
    }

    #[Test]
    public function aFailedRequestClearsTheReasonBeforeIt(): void
    {
        $client = $this->clientWithError('Docker API HTTP 500: old', 'old');
        // The socket does not exist, so the request fails before any HTTP.
        $this->assertFalse($client->startContainer('abc'));
        $this->assertSame('Docker socket not found: /nonexistent.sock', $client->getLastErrorReason());
    }

    #[Test]
    public function isEmptyWithNoError(): void
    {
        $this->assertSame('', $this->clientWithError('')->getLastErrorReason());
    }
}
