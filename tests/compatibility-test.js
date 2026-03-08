// Browser Compatibility Tests

class BrowserCompatibilityTest {
  constructor() {
    this.tests = [];
  }

  addTest(name, testFunction) {
    this.tests.push({
      name,
      testFunction,
      status: 'pending',
      result: null
    });
  }

  async runTests() {
    for (const test of this.tests) {
      try {
        const result = await test.testFunction();
        test.status = 'passed';
        test.result = result;
      } catch (error) {
        test.status = 'failed';
        test.result = error.message;
      }
    }
    return this.tests;
  }

  generateReport() {
    const report = {
      total: this.tests.length,
      passed: this.tests.filter(t => t.status === 'passed').length,
      failed: this.tests.filter(t => t.status === 'failed').length,
      tests: this.tests
    };
    return report;
  }
}

// Test cases
const compatibilityTest = new BrowserCompatibilityTest();

// Content script injection test
compatibilityTest.addTest('Content Script Injection', async () => {
  return new Promise((resolve, reject) > {
    try {
      const script = document.createElement('script');
      script.textContent = 'window.bonsaiTest = true;';
      document.head.appendChild(script);
      document.head.removeChild(script);
      
      if (window.bonsaiTest) {
        resolve('Content script injected successfully');
      } else {
        reject('Content script injection failed');
      }
    } catch (error) {
      reject(error.message);
    }
  });
});

// Background script test
compatibilityTest.addTest('Background Script', async () => {
  return new Promise((resolve, reject) > {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime) {
        resolve('Chrome background script available');
      } else if (typeof browser !== 'undefined' && browser.runtime) {
        resolve('Firefox background script available');
      } else {
        resolve('Background script not available');
      }
    } catch (error) {
      reject(error.message);
    }
  });
});

// Storage sync test
compatibilityTest.addTest('Storage Sync', async () => {
  return new Promise((resolve, reject) > {
    try {
      const storage = chrome && chrome.storage ? chrome.storage : browser && browser.storage;
      
      if (storage) {
        storage.local.set({ test: 'value' }, () > {
          storage.local.get(['test'], (result) > {
            if (result.test === 'value') {
              resolve('Storage sync works');
            } else {
              reject('Storage sync failed');
            }
          });
        });
      } else {
        resolve('Storage not available');
      }
    } catch (error) {
      reject(error.message);
    }
  });
});

// Web request test
compatibilityTest.addTest('Web Request', async () => {
  return new Promise((resolve, reject) > {
    try {
      const webRequest = chrome && chrome.webRequest ? chrome.webRequest : browser && browser.webRequest;
      
      if (webRequest) {
        resolve('Web request API available');
      } else {
        resolve('Web request not available');
      }
    } catch (error) {
      reject(error.message);
    }
  });
});

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
  module.exports = compatibilityTest;
} else {
  window.BrowserCompatibilityTest = compatibilityTest;
}