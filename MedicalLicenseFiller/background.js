// This script runs in the background to handle API calls and central logic

// --- Constants to define Google Sheet structure ---
// **** UPDATE THESE VALUES BASED ON YOUR ACTUAL GOOGLE SHEET ****
const SPREADSHEET_ID = '1s_p-e7ccMN1TOqGxkJp-9mECISc61WxdoHITC096Yms'; 
const SHEET_NAME = 'Provider Data';         // This matches your sheet tab name
const NPI_COLUMN_LETTER = 'A';              // NPI is in Column A 
const DATA_FETCH_RANGE = 'A:Z';             // Fetch data from columns A through Z

// Maps column letters to the exact header names from your sheet 
const COLUMN_MAP = {
    'A': 'NPI', 'B': 'FirstName', 'C': 'LastName', 'D': 'DOB',
    'E': 'MedicalSchoolName', 'F': 'DateDegreeIssued', 'G': 'MedicalDegree',
    'H': 'ExamPassed', 'I': 'ResidencyProgram', 'J': 'ResidencyCompletionDate',
    'K': 'ResidencySpecialty', 'L': 'HomeAddress', 'M': 'HomeAddress2',
    'N': 'Home_City', 'O': 'Home_State', 'P': 'Home_Zip',
    'Q': 'Phone', 'R': 'Gender', 'S': 'SSN', 'T': 'HairColor', 'U': 'EyeColor', 'V': 'Height', 'W': 'Weight', 'X': 'HomeCountry', 'Y': 'DifferentAddress', 'Z': 'BirthPlace'
};
// --- End of Google Sheet structure constants ---

const MAX_ERROR_LOG_SIZE = 100; // Limit how many errors are stored locally

// --- Listen for messages sent from other parts of the extension (like popup.js) ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // --- Handle Request to Fetch Data ---
    if (message.action === "fetchData") {
        const npiToFind = message.npi; // Get the NPI sent from the popup
        console.log("Background: Received request to fetch data for NPI:", npiToFind);

        // Use Chrome's Identity API to get an authentication token for the logged-in Google user
        // 'interactive: true' means it will prompt the user to log in/consent if needed the first time
        chrome.identity.getAuthToken({ interactive: true }, (token) => {
            // Check if getting the token failed
            if (chrome.runtime.lastError || !token) {
                console.error("Background: Auth Error:", chrome.runtime.lastError);
                // Send an error response back to the popup
                sendResponse({ error: `Google Authentication failed: ${chrome.runtime.lastError?.message || 'Unknown reason. Ensure you are logged into Chrome with a Google account that has access to the Sheet.'}` });
                return; // Stop processing this request
            }

            // If token was obtained successfully, call the function to get data from Sheets
            fetchPhysicianData(token, npiToFind)
                .then(data => {
                    // Success! Send the fetched data back to the popup
                    console.log("Background: Data fetched successfully for NPI:", npiToFind);
                    sendResponse({ data: data });
                })
                .catch(error => {
                    // An error occurred during the Sheets API call
                    console.error("Background: Fetch Error for NPI", npiToFind, ":", error);
                    // Send an error response back to the popup
                    sendResponse({ error: error.message || "Failed to fetch data from Google Sheet." });
                });
        });

        // IMPORTANT: Return true to indicate that sendResponse will be called asynchronously (later)
        return true;
    }

    // --- Handle Request to Log an Error ---
    else if (message.action === "logError") {
        const errorToLog = message.error;
        console.log("Background: Received request to log error:", errorToLog);
        // Get the current error log from storage (or an empty array if none exists)
        chrome.storage.local.get({ errorLog: [] }, (result) => {
            let log = result.errorLog;
            log.push(errorToLog); // Add the new error to the array

            // Keep the log from growing indefinitely
            if (log.length > MAX_ERROR_LOG_SIZE) {
                log = log.slice(log.length - MAX_ERROR_LOG_SIZE); // Keep only the most recent errors
            }

            // Save the updated log back to storage
            chrome.storage.local.set({ errorLog: log }, () => {
                if (chrome.runtime.lastError) {
                     console.error("Background: Error saving error log:", chrome.runtime.lastError);
                } else {
                     console.log("Background: Error logged.");
                     // You could optionally send a response back, but it's not usually needed for logging
                     // sendResponse({ status: 'logged' });
                }
            });
        });
        // Return false or nothing, as the response isn't critical here (or handled above)
        return false;
    }

    // If the message action is not recognized, do nothing
    // return false; // Or handle other potential actions
});

// --- Function to actually fetch data from the Google Sheet using the API ---
async function fetchPhysicianData(authToken, npiToFind) {
    // Construct the ranges needed for the API call
    const npiSearchRange = `${SHEET_NAME}!${NPI_COLUMN_LETTER}:${NPI_COLUMN_LETTER}`; // e.g., 'Provider Data'!A:A
    const dataFetchRange = `${SHEET_NAME}!${DATA_FETCH_RANGE}`; // e.g., 'Provider Data'!A:S

    // Google Sheets API endpoint for getting values
    const apiUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchGet`;
    // Add the ranges as query parameters
    const requestUrl = `${apiUrl}?ranges=${encodeURIComponent(npiSearchRange)}&ranges=${encodeURIComponent(dataFetchRange)}&majorDimension=ROWS`;

    console.log("Background: Calling Sheets API URL:", requestUrl); // For debugging

    // Make the authenticated request to the Google Sheets API
    const response = await fetch(requestUrl, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${authToken}` // Include the user's auth token
        }
    });

    // Check if the API request itself failed (e.g., network error, invalid permissions)
    if (!response.ok) {
        const errorData = await response.json().catch(() => ({})); // Try to get error details from response body
        console.error("Background: Google Sheets API error response:", response.status, response.statusText, errorData);
        throw new Error(`Google Sheets API Error: ${response.status} ${response.statusText}. Check Spreadsheet ID, Sheet Name, and permissions.`);
    }

    // Parse the successful JSON response from the API
    const batchData = await response.json();
    // console.log("Background: API Raw Response:", batchData); // For intense debugging

    // Basic validation of the response structure
    if (!batchData.valueRanges || batchData.valueRanges.length < 2 || !batchData.valueRanges[0].values || !batchData.valueRanges[1].values) {
        console.warn("Background: NPI column or Data range appears empty in the sheet, or API response format unexpected.");
        // It's possible the sheet is just empty, which isn't strictly an error, but means no data found.
        return null; // Return null to indicate not found (sheet might be empty)
    }

    const npiValues = batchData.valueRanges[0].values;   // Array of arrays containing NPIs [[npi1], [npi2], ...]
    const allRowData = batchData.valueRanges[1].values; // Array of arrays containing all row data [[row1colA, row1colB,...], [row2colA,...]]

    // Find the row index that matches the NPI we're looking for
    let foundRowIndex = -1;
    for (let i = 0; i < npiValues.length; i++) {
        // Check if the cell exists and matches the NPI (trim whitespace for safety)
        if (npiValues[i] && npiValues[i][0] && String(npiValues[i][0]).trim() === String(npiToFind).trim()) {
            foundRowIndex = i; // Found it! Record the index (0-based)
            break; // Stop searching
        }
    }

    // If the loop finishes and foundRowIndex is still -1, the NPI was not in the sheet
    if (foundRowIndex === -1) {
        console.log(`Background: NPI "${npiToFind}" not found in column ${NPI_COLUMN_LETTER}.`);
        return null; // Return null to indicate NPI not found
    }

    console.log(`Background: NPI found at row index: ${foundRowIndex}`);

    // Get the specific row of data corresponding to the found NPI
    const physicianRow = allRowData[foundRowIndex];
    if (!physicianRow) {
        // This case is unlikely if NPI was found, but good to check
        console.error(`Background: Data row not found at index ${foundRowIndex}, although NPI was found. Sheet data inconsistency?`);
        return null;
    }

    // Convert the array of row data into a more usable JavaScript object
    // using the COLUMN_MAP we defined earlier
    const physicianData = {};
    // Helper to convert column letters ('A', 'B', ..., 'Z', 'AA', etc.) to zero-based indices (0, 1, ..., 25, 26)
    const getColumnIndex = (colLetter) => {
         let index = 0;
         for(let j = 0; j < colLetter.length; j++) {
             index = index * 26 + (colLetter.charCodeAt(j) - ('A'.charCodeAt(0) - 1));
         }
         return index - 1; // Convert 1-based letter index to 0-based array index
     };

    // Loop through our defined COLUMN_MAP
    for (const columnLetter in COLUMN_MAP) {
        const fieldName = COLUMN_MAP[columnLetter]; // Get the internal field name (e.g., 'FirstName')
        const columnIndex = getColumnIndex(columnLetter); // Get the corresponding array index (e.g., 1 for 'B')

        // Get the value from the physician's data row at that index
        // Use `|| ''` to ensure we get an empty string instead of `undefined` if a cell is blank
        const rawValue = (columnIndex >= 0 && columnIndex < physicianRow.length) ? physicianRow[columnIndex] : '';
        physicianData[fieldName] = rawValue || '';
    }

    console.log("Background: Mapped physician data:", physicianData); // For debugging
    return physicianData; // Return the structured data object
}

// Log message indicating the background script has started successfully
console.log("Background service worker started successfully.");

// Optional: Add a listener for when the extension is first installed or updated
chrome.runtime.onInstalled.addListener(details => {
    console.log(`Extension installed or updated. Reason: ${details.reason}`);
    // You could potentially clear old error logs on update if desired:
    // if (details.reason === 'update') {
    //    chrome.storage.local.remove('errorLog', () => console.log('Cleared old error log on update.'));
    // }
});