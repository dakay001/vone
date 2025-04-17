document.addEventListener('DOMContentLoaded', () => {
    const findButton = document.getElementById('findPhysician');
    const fillButton = document.getElementById('fillForm');
    const npiInput = document.getElementById('physicianNpi');
    const dataDisplay = document.getElementById('dataDisplay');
    const statusMessage = document.getElementById('statusMessage');
    const errorLogDisplay = document.getElementById('errorLogDisplay');
    const errorList = document.getElementById('errorList');
  
    // Find Data button
    findButton.addEventListener('click', () => {
      const physicianNpi = npiInput.value.trim();
      if (!physicianNpi) {
        updateStatus("Please enter a physician NPI.", 'error');
        return;
      }
      if (!/^\d{10}$/.test(physicianNpi)) {
        updateStatus("Invalid NPI format (must be 10 digits).", 'error');
        return;
      }
  
      updateStatus("Fetching data...", 'info');
      clearErrorDisplay();
      fillButton.disabled = true;
      clearDataDisplay(false);
  
      chrome.runtime.sendMessage({ action: 'fetchData', npi: physicianNpi }, response => {
        if (response?.error) {
          updateStatus(`Error: ${response.error}`, 'error');
        } else if (response?.data) {
          updateStatus("Data found. Ready to fill.", 'success');
          displayFetchedData(response.data);
          chrome.storage.local.set({ currentPhysicianData: response.data, currentNpi: physicianNpi });
          fillButton.disabled = false;
        } else {
          updateStatus("Physician NPI not found in sheet.", 'error');
        }
      });
    });
  
    // Fill Form button
    fillButton.addEventListener('click', () => {
      updateStatus("Attempting to fill form...", 'info');
      clearErrorDisplay();
  
      chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        const tabId = tabs[0]?.id;
        if (!tabId) {
          updateStatus("Could not find active browser tab.", 'error');
          logPersistentError("Tab Error", "Could not find active tab", "");
          return;
        }
  
        // 1) Inject content script
        chrome.scripting.executeScript({ target: { tabId }, files: ['contentScript.js'] }, injectionResults => {
          if (chrome.runtime.lastError) {
            console.error('Injection failed:', chrome.runtime.lastError.message);
            updateStatus(`Injection failed: ${chrome.runtime.lastError.message}`, 'error');
            logPersistentError('Injection Error', chrome.runtime.lastError.message, tabs[0].url);
            return;
          }
          console.log('✅ contentScript.js injected:', injectionResults);
  
          // 2) Send fillForm message
          chrome.tabs.sendMessage(tabId, { action: 'fillForm' }, response => {
            if (chrome.runtime.lastError) {
              updateStatus(
                `Error communicating with page: ${chrome.runtime.lastError.message}. Try refreshing page.`,
                'error'
              );
              logPersistentError('Communication Error', chrome.runtime.lastError.message, tabs[0].url);
  
            } else if (response?.status === 'success') {
              const statusType = response.issues?.length ? 'info' : 'success';
              updateStatus(
                `Filling complete. Fields filled: ${response.filledCount}. Issues: ${response.issues.length}`,
                statusType
              );
              if (response.issues.length) {
                displayFillErrors(response.issues);
                response.issues.forEach(issue => logPersistentError('Field Issue', issue, tabs[0].url));
              }
  
            } else {
              const errorMessage = response?.message || 'Filling script failed or did not respond correctly.';
              updateStatus(`Form filling failed: ${errorMessage}`, 'error');
              if (response?.issues?.length) {
                displayFillErrors(response.issues);
                response.issues.forEach(issue => logPersistentError('Field Error', issue, tabs[0].url));
              } else {
                logPersistentError('General Fill Error', errorMessage, tabs[0].url);
              }
            }
          });
        });
      });
    });
  
    // Utility functions
    function updateStatus(message, type = 'info') {
      statusMessage.textContent = message;
      statusMessage.className = `status-${type}`;
    }
  
    function clearDataDisplay(clearStatus = true) {
      dataDisplay.innerHTML = '';
      dataDisplay.appendChild(statusMessage);
      if (clearStatus) updateStatus(' ', 'info');
    }
  
    function displayFetchedData(data) {
      clearDataDisplay(true);
      let hasData = false;
      for (const key in data) {
        if (data[key]) {
          hasData = true;
          const div = document.createElement('div');
          div.className = 'field';
          const nameSpan = document.createElement('span');
          nameSpan.textContent = `${key}: ${data[key]}`;
          const statusSpan = document.createElement('span');
          statusSpan.className = 'status';
          statusSpan.textContent = '✓';
          div.append(nameSpan, statusSpan);
          dataDisplay.appendChild(div);
        }
      }
      if (!hasData) updateStatus('Data found, but all relevant fields are empty in the sheet.', 'info');
    }
  
    function clearErrorDisplay() {
      errorList.innerHTML = '';
      errorLogDisplay.style.display = 'none';
    }
  
    function displayFillErrors(issues) {
      errorList.innerHTML = '';
      issues.forEach(issue => {
        const li = document.createElement('li');
        li.textContent = issue;
        errorList.appendChild(li);
      });
      errorLogDisplay.style.display = 'block';
    }
  
    function logPersistentError(errorType, errorMessage, url) {
      chrome.storage.local.get(['currentNpi'], result => {
        const npi = result.currentNpi || 'N/A';
        const entry = { timestamp: new Date().toISOString(), npi, type: errorType, message: errorMessage, pageUrl: url || window.location.href };
        chrome.runtime.sendMessage({ action: 'logError', error: entry });
      });
    }
  
    // Load saved state
    chrome.storage.local.get(['currentPhysicianData', 'currentNpi'], result => {
      if (result.currentPhysicianData && result.currentNpi) {
        npiInput.value = result.currentNpi;
        displayFetchedData(result.currentPhysicianData);
        fillButton.disabled = false;
      }
    });
  });
  