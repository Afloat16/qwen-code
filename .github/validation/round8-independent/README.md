# Round 8 independent baseline

This validation branch executes unchanged reviewed production commits. Expected baseline: MCP two argument-loss failures with seven controls; Memory three incorrect-feedback failures with three controls. The scripts validate these exact failure counts and retain all observations, source hashes, and controls. A green validation job means the baseline reproduction was observed, not that the product was fixed.

Use PHASE=verification and the same test scripts on a fixed source to require every case to pass. The MCP fallback checks the real command builder/parser but does not claim to execute the settings writer. The memory fallback mounts the real panel and resource hooks with controllable transport actions. Neither fallback edits production source.
