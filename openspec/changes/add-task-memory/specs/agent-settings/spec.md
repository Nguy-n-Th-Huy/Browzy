## ADDED Requirements

### Requirement: Task memory toggle
Settings SHALL offer a "Ghi nhớ cách làm việc" switch, on by default, that enables deriving task memories from completed runs and recalling them at run start. Turning it off SHALL stop both derivation and recall without deleting stored memories, and the surface SHALL link to where memories can be forgotten. The switch SHALL state that, while the existing "Không lưu nội dung câu hỏi" privacy control is on, no new memory is written although stored memories are still recalled. The setting SHALL persist on the host and take effect on the next run; it SHALL NOT change an in-flight run.

#### Scenario: Default
- **WHEN** settings are opened on a fresh installation
- **THEN** the switch is on and the hint about the privacy control is visible

#### Scenario: Turned off mid-conversation
- **WHEN** the operator turns the switch off while a run is in flight
- **THEN** that run completes unchanged, and the next run neither derives nor recalls

#### Scenario: Privacy control on
- **WHEN** "Không lưu nội dung câu hỏi" is on and the task memory switch is on
- **THEN** the settings surface shows that new memories are paused while stored ones remain usable
