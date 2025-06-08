# Balancer Flash Loan Arbitrage Bot

This repository contains a proof-of-concept flash loan arbitrage bot designed for the Balancer protocol. It features risk management, dynamic gas controls and optional advanced strategies. The codebase is written in TypeScript and Solidity.

## Features
- Balancer based flash loan executor
- Risk limits and monitoring utilities
- Optional Flashbots integration
- Advanced arbitrage detection module
- Metrics endpoint for Prometheus

## Quick Start
1. Install dependencies
   ```bash
   npm install
   ```
2. Compile contracts
   ```bash
   npx hardhat compile
   ```
3. Copy `.env.example` to `.env` and configure the variables

4. Run the scanner
   ```bash
   npm run start
   ```

See `README.md` for the original Japanese documentation.
