<?php
declare(strict_types=1);

// Deterministic fixture for plan e2e tests: a parse error wrapped by its caller.
final class PriceException extends RuntimeException
{
}

function parsePrice(string $raw): float
{
    if (!is_numeric($raw)) {
        throw new PriceException("Not a price: {$raw}");
    }
    return (float) $raw;
}

/** @param list<string> $rows */
function load(array $rows): array
{
    $prices = [];
    foreach ($rows as $i => $row) {
        try {
            $prices[] = parsePrice($row);
        } catch (PriceException $e) {
            throw new LogicException("Row {$i} is invalid", 0, $e);
        }
    }
    return $prices;
}

try {
    load(['1.50', '2.00', 'n/a']);
} catch (LogicException $e) {
    echo get_class($e->getPrevious()), ': ', $e->getPrevious()->getMessage(), PHP_EOL;
}
