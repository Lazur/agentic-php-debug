<?php
declare(strict_types=1);

// Deterministic fixture for plan e2e tests: line totals are rounded one by one.
final class Cart
{
    /** @param list<array{0: float, 1: int}> $items */
    public function __construct(private array $items)
    {
    }

    public function total(): float
    {
        $total = 0.0;
        foreach ($this->items as [$price, $qty]) {
            $line = $this->lineTotal($price, $qty);
            $total += $line;
        }
        return $total;
    }

    private function lineTotal(float $price, int $qty): float
    {
        $raw = $price * $qty;
        $rounded = round($raw, 2);
        return $rounded;
    }
}

$cart = new Cart([[1.115, 3], [2.5, 1], [0.335, 2]]);
echo $cart->total(), PHP_EOL;
