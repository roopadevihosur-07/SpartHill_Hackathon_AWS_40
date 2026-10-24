# Requirements Document

## Introduction

Lifeline Live is a browser-based crisis-response assistant built for the SpartHill Hacks 2026 AWS AI/ML track. It replaces an earlier phone-line concept with a web application that a caller operates by voice. An at-risk resident "calls in" through a web page, speaks their need, and an Amazon Bedrock agent triages the request, classifies the resource type, matches it to an available site using tool calls, places a hold, dispatches a volunteer driver, and shows an on-screen confirmation. A coordinator (Rosa) supervises through a decision log and can trigger a re-plan when a site runs out of stock.

The system is constrained to the AWS services available on the event account: Amazon Bedrock and Kiro in us-east-1. There is no Amazon Connect, Lex, Lambda, DynamoDB, SMS messaging, Location Service, or Comprehend. The voice interface uses the browser Web Speech API. Tools run in the application backend. State is held in local seed data that stands in for a database. Live external facts come from the openFDA Drug Shortages API and the RxNorm API over HTTPS.

The agent is grounded: tools are the only source of facts, and the agent must not invent sites, stock levels, or shortage data. Risky and medical actions require human approval. Medical red flags trigger an immediate 911 guidance handoff; the agent never gives medical advice.

## Glossary

- **Lifeline_System**: The overall browser-based application, including the web front end, the application backend, and the Bedrock agent orchestration.
- **Voice_Interface**: The browser front-end layer that captures caller speech via the Web Speech API speech-to-text, and plays agent responses via Web Speech API text-to-speech.
- **Bedrock_Agent**: The Amazon Bedrock agent (us-east-1) that performs triage, resource classification, tool selection, re-planning, and safety escalation through tool/function calling.
- **Tool_Layer**: The set of application-backend functions the Bedrock_Agent can call: find_resource, check_shortage, reserve, dispatch_volunteer, escalate, and the optional normalize_drug. These are not AWS Lambda functions.
- **Caller**: An at-risk resident who requests help through the Voice_Interface (for example, Mr. Nguyen).
- **Rosa**: The volunteer dispatch coordinator who approves risky or medical actions and views the Decision_Log.
- **Volunteer_Driver**: A person assigned to transport a resource; receives an on-screen Dispatch_Card.
- **Resource_Type**: One of six categories a need is classified into: medicine, food, water, shelter, power, info.
- **Seed_Data**: The in-memory/local JSON data that stands in for a database, holding 5 pharmacies, 3 food banks, 2 cooling centers, 4 volunteers, and 3 opted-in residents, plus holds and the Decision_Log.
- **Hold**: A reservation placed against a resource site that reduces its available stock and is identified by a unique Hold_Id. Hold creation uses conditional-write semantics simulated in app state.
- **Hold_Id**: The unique identifier returned when a Hold is created.
- **Dispatch**: The act of assigning a Volunteer_Driver to fulfill a Hold and producing a Dispatch_Card.
- **Dispatch_Card**: An on-screen card shown to the Volunteer_Driver containing pickup location, drop-off location, route, and estimated time of arrival (ETA).
- **Confirmation_Card**: An on-screen card shown to the Caller summarizing the matched site, Hold_Id, assigned driver, and ETA, standing in for an SMS confirmation.
- **Re_Plan**: The process in which the Bedrock_Agent detects that a reserved site can no longer fulfill a need, selects the next nearest qualifying site, re-routes the Volunteer_Driver, and updates the Caller.
- **Red_Flag**: A medical danger signal in the Caller's speech, specifically chest pain, difficulty breathing, or confusion, that requires immediate 911 guidance handoff.
- **Decision_Log**: The chronological record, visible to Rosa, of every decision the Bedrock_Agent makes, each stored with its reason.
- **TTL_Expiry**: The simulated time-to-live auto-expiry that removes caller records after the crisis window closes.
- **openFDA_Shortage_API**: The external openFDA Drug Shortages HTTPS API used to check medicine shortage status.
- **RxNorm_API**: The external RxNorm HTTPS API used to normalize drug names.

## Requirements

### Requirement 1: Start a browser voice session

**User Story:** As a Caller, I want to speak my request in the browser and hear the agent respond, so that I can get help without a phone line.

#### Acceptance Criteria

1. WHEN a Caller opens the web page and starts a session, THE Voice_Interface SHALL request microphone access and begin speech-to-text capture within 1 second of access being granted.
2. WHEN the Caller finishes speaking an utterance, as detected by 1.5 seconds of silence, THE Voice_Interface SHALL transcribe the utterance to text and send the text to the Bedrock_Agent.
3. WHEN the Bedrock_Agent returns a response, THE Voice_Interface SHALL display the response as text within 1 second of receiving it.
4. WHEN the Bedrock_Agent returns a response, THE Voice_Interface SHALL play the response as speech using text-to-speech.
5. IF the browser does not support the Web Speech API, THEN THE Voice_Interface SHALL display a text-input field accepting up to 1000 characters so the Caller can type the request.
6. IF microphone access is denied, THEN THE Voice_Interface SHALL display a message stating that voice input is unavailable, offer the text-input field accepting up to 1000 characters, and preserve the in-progress session.
7. IF transcription fails or the Bedrock_Agent does not respond within 15 seconds, THEN THE Voice_Interface SHALL display an error indication, offer the Caller the option to retry, and preserve the in-progress session.

### Requirement 2: Triage and classify the need

**User Story:** As a Caller, I want the agent to understand what kind of help I need, so that it can route me to the right resource.

#### Acceptance Criteria

1. WHEN the Bedrock_Agent receives transcribed Caller text containing at least one non-whitespace character, THE Bedrock_Agent SHALL classify the need into exactly one Resource_Type from the set {medicine, food, water, shelter, power, info} within 5 seconds of receiving the text.
2. IF the transcribed Caller text is empty or contains only whitespace, THEN THE Bedrock_Agent SHALL request the Caller to restate their need and SHALL NOT select a Resource_Type.
3. IF the Caller request maps to zero Resource_Types or to two or more Resource_Types with equal likelihood, THEN THE Bedrock_Agent SHALL ask one clarifying question before selecting a Resource_Type.
4. IF the Caller request still maps to zero or to two or more equally likely Resource_Types after 2 clarifying questions, THEN THE Bedrock_Agent SHALL classify the need as the Resource_Type info.
5. WHEN the Bedrock_Agent selects a Resource_Type, THE Bedrock_Agent SHALL record the selected Resource_Type, the classification reason, and the count of clarifying questions asked in the Decision_Log.
6. IF a write to the Decision_Log fails, THEN THE Bedrock_Agent SHALL retry the write up to 3 times and, if all retries fail, SHALL surface an error indication that the classification was not logged while retaining the selected Resource_Type.

### Requirement 3: Find a matching resource site

**User Story:** As a Caller, I want to be matched to the nearest open site that has what I need, so that I can receive the resource quickly.

#### Acceptance Criteria

1. WHEN the Bedrock_Agent has a classified Resource_Type, THE Bedrock_Agent SHALL call the find_resource tool with that Resource_Type within 2 seconds of classification.
2. WHEN the find_resource tool is called, THE Tool_Layer SHALL return sites from Seed_Data whose open status is true and whose available stock for the requested Resource_Type is 1 unit or greater.
3. WHEN the find_resource tool returns qualifying sites, THE Tool_Layer SHALL order them by nearest first.
4. WHEN more than 5 sites qualify, THE Tool_Layer SHALL return at most the 5 nearest sites.
5. THE Bedrock_Agent SHALL present only sites and values returned by the find_resource tool and SHALL NOT present any site, stock level, or availability value not present in the tool response.
6. IF the find_resource tool returns no qualifying site, THEN THE Bedrock_Agent SHALL inform the Caller that no matching site is available and record the outcome, the Resource_Type, and a timestamp in the Decision_Log.
7. IF the find_resource tool fails or does not return within 5 seconds, THEN THE Bedrock_Agent SHALL inform the Caller that the lookup is unavailable and record the failure in the Decision_Log.

### Requirement 4: Live medicine shortage check

**User Story:** As a Caller requesting medicine, I want the agent to check whether the drug is in shortage, so that I am directed to a site that can actually supply it.

#### Acceptance Criteria

1. WHEN the classified Resource_Type is medicine, THE Bedrock_Agent SHALL call the check_shortage tool, which queries the openFDA_Shortage_API over HTTPS for the requested drug.
2. WHEN the check_shortage tool queries the openFDA_Shortage_API, THE check_shortage tool SHALL apply a request timeout of 5 seconds and retry the query at most 2 times before returning a result.
3. WHEN the openFDA_Shortage_API reports the requested drug as in shortage, THE Bedrock_Agent SHALL record the shortage status, the drug identifier, and the retrieval timestamp in the Decision_Log and exclude sites that cannot supply the drug from site selection.
4. WHEN the openFDA_Shortage_API reports the requested drug as not in shortage, THE Bedrock_Agent SHALL record the not-in-shortage status, the drug identifier, and the retrieval timestamp in the Decision_Log and include the drug as available during site selection.
5. IF the openFDA_Shortage_API is unreachable, returns an error, or does not respond within 5 seconds after 2 retries, THEN THE check_shortage tool SHALL return an error status, and THE Bedrock_Agent SHALL inform the Caller with a message indicating that shortage status is currently unavailable, record the unavailable status in the Decision_Log, and refrain from asserting any shortage or availability status for the requested drug.

### Requirement 5: Reserve a hold

**User Story:** As a Caller, I want a hold placed on the resource at the chosen site, so that it is set aside for me.

#### Acceptance Criteria

1. WHEN the Caller confirms a selected site, THE Bedrock_Agent SHALL call the reserve tool exactly once with that site identifier and the Resource_Type within 5 seconds of confirmation.
2. WHEN the reserve tool succeeds, THE Tool_Layer SHALL decrement the site's available stock in Seed_Data by 1 and return a Hold_Id that is unique across all existing Hold records.
3. IF the reserve tool is called for a site whose available stock is zero, THEN THE Tool_Layer SHALL reject the reservation using conditional-write semantics, leave the site's available stock unchanged in Seed_Data, and return a failure status indicating no stock is available.
4. IF the reserve tool is called for a site whose available stock is greater than zero but the conditional-write fails due to a concurrent update, THEN THE Tool_Layer SHALL return a failure status indicating a conflict and leave the site's available stock unchanged in Seed_Data.
5. WHEN a Hold is created, THE Bedrock_Agent SHALL record the Hold_Id, the site identifier, and the reason for the reservation as a single entry in the Decision_Log.

### Requirement 6: Dispatch a volunteer driver

**User Story:** As a Volunteer_Driver, I want a dispatch card with pickup, drop-off, route, and ETA, so that I know where to go.

#### Acceptance Criteria

1. WHEN a Hold is created, THE Bedrock_Agent SHALL call the dispatch_volunteer tool to assign an available Volunteer_Driver from Seed_Data within 5 seconds of the Hold being created.
2. WHEN the dispatch_volunteer tool assigns a driver, THE Lifeline_System SHALL display a Dispatch_Card showing pickup location, drop-off location, route, and ETA, where ETA is expressed in whole minutes and route includes an ordered sequence from pickup location to drop-off location.
3. IF the Dispatch_Card cannot be populated because pickup location, drop-off location, route, or ETA is unavailable, THEN THE Lifeline_System SHALL display an error indicating which field is missing and SHALL retain the driver assignment without displaying a partial Dispatch_Card.
4. IF no Volunteer_Driver is available in Seed_Data when a Hold is created, THEN THE Bedrock_Agent SHALL record the gap in the Decision_Log and alert Rosa within 5 seconds of determining no driver is available.
5. WHEN a driver is dispatched, THE Bedrock_Agent SHALL record in the Decision_Log the assigned Volunteer_Driver identifier, the associated Hold, the assignment timestamp, and the reason for the assignment.

### Requirement 7: Caller confirmation card

**User Story:** As a Caller, I want an on-screen confirmation after dispatch, so that I know help is on the way.

#### Acceptance Criteria

1. WHEN a Volunteer_Driver is dispatched for a Hold, THE Lifeline_System SHALL display a Confirmation_Card to the Caller showing the matched site, Hold_Id, assigned driver, and ETA.
2. THE Confirmation_Card SHALL stand in for an SMS confirmation and SHALL be shown on screen rather than sent as a real message.

### Requirement 8: Re-plan on stock-out

**User Story:** As Rosa, I want the agent to re-plan when a site runs out, so that the Caller still receives the resource.

#### Acceptance Criteria

1. WHEN Rosa presses the admin "out of stock" button for the reserved site, THE Lifeline_System SHALL set that site's stock for the reserved Resource_Type to zero in Seed_Data and send a stock-out notification to the Bedrock_Agent within 5 seconds of the button press.
2. WHEN the Bedrock_Agent receives a stock-out notification indicating the reserved site reports zero stock for the reserved Resource_Type, THE Bedrock_Agent SHALL request from the find_resource tool the next nearest qualifying site that reports stock of at least one unit for that Resource_Type and place a new Hold at that site.
3. IF the find_resource tool returns no qualifying site with stock of at least one unit for the reserved Resource_Type, THEN THE Lifeline_System SHALL cancel the existing Hold, display an error message on the Dispatch_Card and the Caller Confirmation_Card indicating that no alternative site is available, and record the failed Re_Plan attempt in the Decision_Log.
4. WHEN the Bedrock_Agent places a new Hold during a Re_Plan, THE Lifeline_System SHALL re-route the Volunteer_Driver to the new site and update the Dispatch_Card and the Caller Confirmation_Card with the new site details within 30 seconds of the "out of stock" button press.
5. WHEN the Bedrock_Agent places a new Hold during a Re_Plan, THE Bedrock_Agent SHALL record the Re_Plan in the Decision_Log, including the superseded site, the new site, and the reason.

### Requirement 9: Medical safety escalation

**User Story:** As a Caller in medical danger, I want to be directed to emergency help immediately, so that I stay safe.

#### Acceptance Criteria

1. WHEN the Caller's transcribed speech contains a Red_Flag of chest pain, difficulty breathing, or confusion, THE Bedrock_Agent SHALL call the escalate tool and deliver spoken 911 guidance to the Caller within 3 seconds of Red_Flag detection.
2. WHEN a Red_Flag is detected, THE Bedrock_Agent SHALL alert Rosa and record the escalation, the detected Red_Flag, and the escalation reason in the Decision_Log within 5 seconds of Red_Flag detection.
3. THE Bedrock_Agent SHALL NOT provide medical advice or diagnosis, and WHEN the Caller asks a medical question, THE Bedrock_Agent SHALL direct the Caller to emergency services or a licensed professional.
4. WHEN a Red_Flag is detected, THE Bedrock_Agent SHALL complete delivery of the 911 guidance handoff before performing any resource-matching action for the Caller.
5. IF the escalate tool call fails, THEN THE Bedrock_Agent SHALL deliver spoken 911 guidance to the Caller, record the escalation failure and reason in the Decision_Log, and alert Rosa of the failed escalation.

### Requirement 10: Decision log

**User Story:** As Rosa, I want a record of every agent decision with its reason, so that I can supervise and audit the response.

#### Acceptance Criteria

1. WHEN the Bedrock_Agent makes a decision, including triage, classification, tool calls, holds, dispatches, re-plans, and escalations, THE Bedrock_Agent SHALL append an entry to the Decision_Log containing the decision, its reason, and a timestamp.
2. WHEN Rosa opens the console, THE Lifeline_System SHALL display the Decision_Log entries in chronological order.

### Requirement 11: Human-in-the-loop approval

**User Story:** As Rosa, I want to approve risky and medical actions, so that the agent does not act unsafely on its own.

#### Acceptance Criteria

1. WHEN the Bedrock_Agent reaches a risky or medical action, THE Bedrock_Agent SHALL request Rosa's approval and record the pending action in the Decision_Log before executing the action.
2. WHILE an action is awaiting Rosa's approval, THE Bedrock_Agent SHALL NOT execute that action.
3. WHEN Rosa approves a pending action, THE Bedrock_Agent SHALL execute the action and record the approval in the Decision_Log.
4. IF Rosa rejects a pending action, THEN THE Bedrock_Agent SHALL cancel the action and record the rejection in the Decision_Log.

### Requirement 12: Grounded facts

**User Story:** As Rosa, I want the agent to rely only on tools for facts, so that callers receive accurate information.

#### Acceptance Criteria

1. THE Bedrock_Agent SHALL treat the Tool_Layer and external APIs as the only source of facts about sites, stock, shortages, drivers, and holds.
2. IF a tool returns no data for a request, THEN THE Bedrock_Agent SHALL state that the information is unavailable rather than generating site, stock, or shortage values.

### Requirement 13: Consent, PII redaction, and record expiry

**User Story:** As a Caller, I want my personal information protected, so that my privacy is respected during the crisis.

#### Acceptance Criteria

1. WHEN the Bedrock_Agent needs to save the Caller's address, THE Bedrock_Agent SHALL request verbal consent and store the address only after receiving an affirmative verbal response from the Caller.
2. IF the Caller declines consent or gives no response within 30 seconds, THEN THE Bedrock_Agent SHALL NOT store the address and SHALL continue with information the Caller is willing to provide.
3. WHEN a transcript is stored, THE Lifeline_System SHALL redact personally identifiable information, including name, street address, phone number, and email, by substituting placeholders before the transcript is persisted.
4. IF redaction of a stored transcript fails, THEN THE Lifeline_System SHALL NOT persist the unredacted transcript and SHALL record the redaction failure.
5. WHEN 24 hours have elapsed since a Caller record was created, THE Lifeline_System SHALL delete the Caller record using TTL_Expiry.

### Requirement 14: Accessibility and in-browser operation

**User Story:** As a Caller using assistive technology, I want the app to work in a standard browser, so that I can access help.

#### Acceptance Criteria

1. THE Lifeline_System SHALL operate entirely in a standard web browser without native app installation.
2. THE Voice_Interface SHALL provide both voice and visible text for each agent response so that the Caller can read or hear the response.

### Requirement 15: Stretch capabilities (optional, out of MVP scope)

**User Story:** As the team, I want clearly marked stretch goals, so that extra features are pursued only after the MVP is complete.

#### Acceptance Criteria

1. WHERE the proactive-notification stretch option is enabled, WHEN a shortage event relevant to an opted-in resident is detected, THE Lifeline_System SHALL display an in-browser simulated outbound "we call you" notification within 5 seconds, since no outbound phone service is available.
2. WHERE the proactive-notification stretch option is enabled, IF the resident has not opted in, THEN THE Lifeline_System SHALL suppress the notification and record the suppression reason indicating no opt-in consent.
3. WHERE the surge-test stretch option is enabled, WHEN the surge test is initiated, THE Lifeline_System SHALL run 100 to 200 concurrent simulated requests against the Tool_Layer and report p95 latency in milliseconds and error rate as a percentage of failed requests over total requests.
4. WHERE the drug-normalization stretch option is enabled, WHEN a shortage check is requested, THE Bedrock_Agent SHALL call the normalize_drug tool, which queries the RxNorm_API over HTTPS to normalize the drug name before the shortage check proceeds.
5. WHERE the drug-normalization stretch option is enabled, IF the RxNorm_API is unreachable or returns no match within 5 seconds, THEN THE Bedrock_Agent SHALL proceed with the unnormalized drug name and record an indication that normalization did not complete.
6. WHERE the multilingual stretch option is enabled, WHEN a resident selects Spanish or Vietnamese, THE Voice_Interface SHALL accept voice input and produce voice output in the selected language.
