// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ICircuitBreaker {
    function isPaused() external view returns (bool);
}

/**
 * A contract that fails on demand, so the detector can be tested against real
 * failures rather than fixtures.
 *
 * Every scenario the harness needs is a deliberate, reproducible pathology:
 *
 * - `work()` with the trap armed reverts *only once mined*, which is the state
 *   drift behind R4. A node simulating the call at the current block sees the
 *   trap disarmed and reports success; by the time the transaction is included
 *   a block has passed and the same call reverts. This is the honest version of
 *   "simulation passed, execution failed" — nothing about the call changed,
 *   only the chain state underneath it.
 * - `alwaysRevert()` never succeeds, which drives a retry storm (R5).
 * - `movePrice()` and `swap()` reproduce adverse inclusion (R7): a swap that
 *   was quoted at one price and executes at another because someone moved the
 *   market in between.
 * - The optional breaker makes P4 demonstrable end to end: once Blackbox pauses
 *   the breaker, `work()` stops accepting anything at all.
 *
 * Testnet only, by construction and by the harness's compiled-in chain guard.
 * Nothing here is safe or sensible to deploy to a chain that matters.
 */
contract ChaosTarget {
    event Worked(address indexed caller, uint256 count);
    event TrapArmed(uint256 atBlock);
    event TrapDisarmed();
    event PriceMoved(uint256 from, uint256 to);
    event Swapped(address indexed caller, uint256 quotedPrice, uint256 executedPrice);

    /// Carries both blocks so the revert reason itself proves the drift.
    error TrapSprung(uint256 armedAtBlock, uint256 executedAtBlock);
    error AlwaysReverts();
    error BreakerPaused();
    error PriceTooHigh(uint256 executedPrice, uint256 maxPrice);

    bool public trapArmed;
    uint256 public trapArmedAtBlock;
    uint256 public workCount;
    uint256 public price = 1 ether;
    ICircuitBreaker public breaker;

    constructor(address breakerAddress) {
        if (breakerAddress != address(0)) breaker = ICircuitBreaker(breakerAddress);
    }

    /**
     * Arm the trap.
     *
     * `work()` still succeeds in the block this lands in — that is what makes
     * the scenario reliable. The harness arms the trap, waits for that
     * transaction to be mined, and then submits `work()`: the simulation runs
     * against the armed-at block and passes, and inclusion happens at least one
     * block later and reverts.
     */
    function armTrap() external {
        trapArmed = true;
        trapArmedAtBlock = block.number;
        emit TrapArmed(block.number);
    }

    function disarm() external {
        trapArmed = false;
        emit TrapDisarmed();
    }

    /// Succeeds normally, unless the trap has been armed in an earlier block.
    function work() external {
        if (address(breaker) != address(0) && breaker.isPaused()) revert BreakerPaused();
        if (trapArmed && block.number > trapArmedAtBlock) {
            revert TrapSprung(trapArmedAtBlock, block.number);
        }
        workCount += 1;
        emit Worked(msg.sender, workCount);
    }

    /// Never succeeds. Points a retrying action at a guaranteed failure (R5).
    function alwaysRevert() external pure {
        revert AlwaysReverts();
    }

    /// Move the market. Used to make a pending swap execute at a worse price.
    function movePrice(uint256 newPrice) external {
        emit PriceMoved(price, newPrice);
        price = newPrice;
    }

    /**
     * Swap at whatever the price is when this executes.
     *
     * `quotedPrice` is what the caller expected; the difference between it and
     * the executed price is the adverse inclusion R7 looks for. Deliberately
     * has no slippage check — a reverting swap is a different incident, and
     * this one has to *succeed badly* to be the failure being reproduced.
     */
    function swap(uint256 quotedPrice) external returns (uint256 executedPrice) {
        if (address(breaker) != address(0) && breaker.isPaused()) revert BreakerPaused();
        executedPrice = price;
        emit Swapped(msg.sender, quotedPrice, executedPrice);
    }

    /// The same swap with a slippage bound, for comparison in the console.
    function swapWithLimit(uint256 maxPrice) external returns (uint256 executedPrice) {
        executedPrice = price;
        if (executedPrice > maxPrice) revert PriceTooHigh(executedPrice, maxPrice);
        emit Swapped(msg.sender, maxPrice, executedPrice);
    }

    function setBreaker(address breakerAddress) external {
        breaker = ICircuitBreaker(breakerAddress);
    }
}
