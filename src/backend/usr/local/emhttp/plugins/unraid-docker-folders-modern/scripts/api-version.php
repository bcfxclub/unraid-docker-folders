#!/usr/bin/php
<?php
/**
 * Check the running Unraid API version against include/api-compat.json.
 *
 *   php api-version.php          print "ok" and exit 0, or print the reason
 *                                and exit 1
 *   php api-version.php --json   print {version, supported, reason, range}
 *
 * scripts/api-plugin.sh calls it before an install, so the shell and the
 * settings page refuse the same versions for the same reason.
 */

require_once dirname(__DIR__) . '/include/config.php';

$version = dfmUnraidApiVersion();
$range = dfmApiCompatRange();
$reason = dfmApiVersionReason($version, $range);

if (in_array('--json', $argv, true)) {
  echo json_encode([
    'version' => $version,
    'supported' => $reason === '',
    'reason' => $reason,
    'range' => $range,
  ]) . "\n";
  exit($reason === '' ? 0 : 1);
}

echo ($reason === '' ? 'ok' : $reason) . "\n";
exit($reason === '' ? 0 : 1);
