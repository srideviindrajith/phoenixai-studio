const { test, expect } = require('@playwright/test');

test.describe('Phase 1 Admin Panel Bug Fixes', () => {
  test.beforeAll(async () => {
    // Server is assumed to be running already
    // Wait for server to be ready
    await new Promise(resolve => setTimeout(resolve, 2000));
  });

  test.use({ timeout: 60000 });

  test('Item 1: Admin panel loads and renders correctly after dead code removal', async ({ page }) => {
    // Navigate to admin panel
    await page.goto('http://localhost:3000/admin');
    
    // Wait for page to load
    await page.waitForLoadState('networkidle');
    
    // Take screenshot of initial state
    await page.screenshot({ path: 'tests/screenshots/admin-initial.png' });
    
    // Check login form is present
    await expect(page.locator('input[type="password"]')).toBeVisible();
    
    // Log in
    await page.fill('input[type="password"]', 'admin123');
    await page.click('button[type="submit"]');
    
    // Wait for dashboard to load
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('.admin-content', { timeout: 5000 });
    
    // Take screenshot of dashboard
    await page.screenshot({ path: 'tests/screenshots/admin-dashboard.png' });
    
    // Navigate to Leads section
    await page.click('text=Leads');
    await page.waitForLoadState('networkidle');
    
    // Take screenshot of Leads list
    await page.screenshot({ path: 'tests/screenshots/leads-list.png' });
    
    // Get initial row count
    const initialRows = await page.locator('#leads-table-body tr').count();
    console.log('Initial leads count:', initialRows);
    
    // Test search filter
    await page.fill('#leads-search', 'test');
    await page.screenshot({ path: 'tests/screenshots/leads-filtered.png' });
    
    // Get filtered row count
    const filteredRows = await page.locator('#leads-table-body tr').count();
    console.log('Filtered leads count:', filteredRows);
    
    // Clear search
    await page.fill('#leads-search', '');
    
    // Test status filter
    await page.selectOption('#leads-status-filter', 'New');
    await page.screenshot({ path: 'tests/screenshots/leads-status-filter.png' });
    
    // Get status-filtered row count
    const statusFilteredRows = await page.locator('#leads-table-body tr').count();
    console.log('Status-filtered leads count:', statusFilteredRows);
    
    // Navigate to Inquiries section
    await page.click('text=Inquiries');
    await page.waitForLoadState('networkidle');
    
    // Take screenshot of Inquiries list
    await page.screenshot({ path: 'tests/screenshots/inquiries-list.png' });
    
    // Navigate to Notifications section
    await page.click('text=Notifications');
    await page.waitForLoadState('networkidle');
    
    // Take screenshot of Notifications list
    await page.screenshot({ path: 'tests/screenshots/notifications-list.png' });
    
    // Get initial badge count
    const badgeText = await page.textContent('#notification-badge');
    console.log('Initial notification badge:', badgeText);
    
    // If there are notifications, mark one as read
    const notificationRows = await page.locator('#notifications-table-body tr').count();
    console.log('Notification rows count:', notificationRows);
    if (notificationRows > 0) {
      // Try to find and click the mark read button - check different possible selectors
      const markReadButton = page.locator('#notifications-table-body button').first();
      const buttonText = await markReadButton.textContent();
      console.log('First notification button text:', buttonText);
      
      if (buttonText && buttonText.includes('Mark')) {
        await markReadButton.click();
        await page.waitForTimeout(1000);
        
        // Get updated badge count
        const updatedBadgeText = await page.textContent('#notification-badge');
        console.log('Updated notification badge:', updatedBadgeText);
      }
    }
  });

  test('Item 4: Double-click protection prevents duplicate submissions', async ({ page }) => {
    // Navigate to admin panel and log in
    await page.goto('http://localhost:3000/admin');
    await page.fill('input[type="password"]', 'admin123');
    await page.click('button[type="submit"]');
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('.admin-content', { timeout: 5000 });
    
    // Navigate to Packages section
    await page.click('text=Packages');
    await page.waitForLoadState('networkidle');
    
    // Get initial package count
    const initialCount = await page.locator('#packages-table-body tr').count();
    console.log('Initial package count:', initialCount);
    
    // Click "Add Package"
    await page.click('button:has-text("Add Package")');
    await page.waitForSelector('#package-modal', { timeout: 5000 });
    
    // Fill out the form
    await page.fill('#package-name', 'Test Package Double Click');
    await page.fill('#package-slug', 'test-double-click');
    await page.fill('#package-price', '100');
    await page.selectOption('#package-currency', 'INR');
    await page.selectOption('#package-billing-type', 'one-time');
    await page.fill('#package-description', 'Test for double-click protection');
    
    // Get submit button state before
    const submitButton = page.locator('#package-form button[type="submit"]');
    const buttonTextBefore = await submitButton.textContent();
    const buttonDisabledBefore = await submitButton.isDisabled();
    console.log('Button text before:', buttonTextBefore);
    console.log('Button disabled before:', buttonDisabledBefore);
    
    // Simulate double-click by clicking twice rapidly
    // Use Promise.all to click as fast as possible
    await Promise.all([
      submitButton.click(),
      submitButton.click()
    ]);
    
    // Wait for modal to close or for operation to complete
    await page.waitForTimeout(3000);
    
    // Check if modal is closed
    const modalVisible = await page.isVisible('#package-modal');
    console.log('Modal visible after submit:', modalVisible);
    
    // Get button state after
    const buttonTextAfter = await submitButton.textContent();
    const buttonDisabledAfter = await submitButton.isDisabled();
    console.log('Button text after:', buttonTextAfter);
    console.log('Button disabled after:', buttonDisabledAfter);
    
    // Wait for data to reload
    await page.waitForLoadState('networkidle');
    
    // Get final package count
    const finalCount = await page.locator('#packages-table-body tr').count();
    console.log('Final package count:', finalCount);
    
    // Verify only one package was created (not two)
    // Double-click protection should prevent duplicates
    expect(finalCount).toBeLessThanOrEqual(initialCount + 1);
    expect(finalCount).toBeGreaterThanOrEqual(initialCount);
    
    // Test with Lead form as well
    await page.click('text=Leads');
    await page.waitForLoadState('networkidle');
    
    const initialLeadCount = await page.locator('#leads-table-body tr').count();
    console.log('Initial lead count:', initialLeadCount);
    
    await page.click('button:has-text("Add Lead")');
    await page.waitForSelector('#lead-modal', { timeout: 5000 });
    
    await page.fill('#lead-name', 'Test Lead Double Click');
    await page.fill('#lead-email', 'test@example.com');
    await page.fill('#lead-phone', '555-1234');
    await page.fill('#lead-company', 'Test Company');
    await page.fill('#lead-service', 'Website Development');
    await page.selectOption('#lead-source', 'Website');
    await page.selectOption('#lead-status', 'New');
    await page.selectOption('#lead-priority', 'Medium');
    
    const leadSubmitButton = page.locator('#lead-form button[type="submit"]');
    const leadButtonTextBefore = await leadSubmitButton.textContent();
    console.log('Lead button text before:', leadButtonTextBefore);
    
    // Double-click the submit button
    await Promise.all([
      leadSubmitButton.click(),
      leadSubmitButton.click()
    ]);
    
    await page.waitForTimeout(3000);
    
    const leadButtonTextAfter = await leadSubmitButton.textContent();
    console.log('Lead button text after:', leadButtonTextAfter);
    
    await page.waitForLoadState('networkidle');
    
    const finalLeadCount = await page.locator('#leads-table-body tr').count();
    console.log('Final lead count:', finalLeadCount);
    
    // The double-click protection should prevent duplicates
    // So the count should be either initial+1 (successful single submit) or initial (both prevented)
    // It should NOT be initial+2 (duplicate created)
    expect(finalLeadCount).toBeLessThanOrEqual(initialLeadCount + 1);
    expect(finalLeadCount).toBeGreaterThanOrEqual(initialLeadCount);
  });

  test('Item 4 edge cases: Button label restoration and error handling', async ({ page }) => {
    await page.goto('http://localhost:3000/admin');
    await page.fill('input[type="password"]', 'admin123');
    await page.click('button[type="submit"]');
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('.admin-content', { timeout: 5000 });
    
    // Test 1: Verify button label is saved and restored
    await page.click('text=Packages');
    await page.waitForLoadState('networkidle');
    await page.click('button:has-text("Add Package")');
    await page.waitForSelector('#package-modal', { timeout: 5000 });
    
    const submitButton = page.locator('#package-form button[type="submit"]');
    const originalText = await submitButton.textContent();
    console.log('Original button text:', originalText);
    
    // Fill required fields
    await page.fill('#package-name', 'Test Label Restoration');
    await page.fill('#package-slug', 'test-label');
    await page.fill('#package-price', '100');
    await page.selectOption('#package-currency', 'INR');
    await page.selectOption('#package-billing-type', 'one-time');
    await page.fill('#package-description', 'Test');
    
    // Submit and monitor button state
    await submitButton.click();
    
    // Check button shows "Saving..."
    const savingText = await submitButton.textContent();
    console.log('Button text during save:', savingText);
    expect(savingText).toBe('Saving...');
    
    // Wait for modal to close
    await page.waitForSelector('#package-modal', { state: 'hidden', timeout: 5000 });
    
    // Check button is re-enabled and text restored
    const finalText = await submitButton.textContent();
    const isDisabled = await submitButton.isDisabled();
    console.log('Button text after save:', finalText);
    console.log('Button disabled after save:', isDisabled);
    expect(finalText).toBe(originalText);
    expect(isDisabled).toBe(false);
    
    // Test 2: Verify validation failure doesn't disable button permanently
    await page.click('button:has-text("Add Package")');
    await page.waitForSelector('#package-modal', { timeout: 5000 });
    
    // Don't fill required fields - try to submit
    const validationButton = page.locator('#package-form button[type="submit"]');
    await validationButton.click();
    
    // Browser validation should prevent submission
    // Button should not be disabled since submit was prevented
    const validationDisabled = await validationButton.isDisabled();
    console.log('Button disabled after validation failure:', validationDisabled);
    expect(validationDisabled).toBe(false);
    
    // Close the modal using the specific cancel button in package modal
    await page.locator('#package-modal button.cancel-button').click();
  });
});
