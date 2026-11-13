const STORAGE_USERS = 'infinity_users';
const STORAGE_SESSION = 'infinity_session';

const months = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

let registeredCosts = [];
let transactions = [];
let products = [];
let sales = [];
let teamMembers = [];
let pricingHistory = [];
let lastCalculation = null;
let editingCalculationId = null;
let homeSalesRefreshTimer = null;
let pricingDraftTimer = null;
let pricingDraftSaveQueue = Promise.resolve();
let calculatorDraftDirty = false;
let loadedOwnerEmail = '';

function showCalculatorMessage(message) {
    const element = document.getElementById('calculatorMessage');
    element.textContent = message;
    element.classList.toggle('hidden', !message);
}

function setCalculatorActionState(enabled) {
    document.getElementById('saveCalculationBtn').disabled = !enabled;
    document.getElementById('exportCalculationBtn').disabled = !enabled;
}

function getCalculatorNumber(id) {
    const value = document.getElementById(id).value.trim();
    return value === '' ? 0 : Number(value);
}

function getCalculatorInputs() {
    return {
        serviceName: document.getElementById('serviceName').value.trim(),
        hourlyRate: document.getElementById('hourlyRate').value.trim() === ''
            ? null
            : Number(document.getElementById('hourlyRate').value),
        mat: getCalculatorNumber('mat'),
        labor: getCalculatorNumber('labor'),
        markup: getCalculatorNumber('markup'),
        tax: getCalculatorNumber('tax'),
        businessModel: document.getElementById('businessModel').value,
        costs: registeredCosts.map((item) => ({ ...item }))
    };
}

function getCalculatorValidationError(inputs) {
    if (!Number.isFinite(inputs.markup) || inputs.markup < 0 || inputs.markup > 100) {
        return 'A margem deve estar entre 0% e 100%. Corrija esse campo para continuar.';
    }
    if (!Number.isFinite(inputs.tax) || inputs.tax < 0 || inputs.tax > 100) {
        return 'Os impostos devem estar entre 0% e 100%. Corrija esse campo para continuar.';
    }
    if (inputs.markup + inputs.tax >= 100) {
        return 'A soma da margem e dos impostos deve ser menor que 100%. Ajuste um dos valores.';
    }
    if (![inputs.mat, inputs.labor].every((value) => Number.isFinite(value) && value >= 0)) {
        return 'Matéria-prima e mão de obra devem ter valores iguais ou maiores que zero.';
    }
    if (inputs.hourlyRate !== null && (!Number.isFinite(inputs.hourlyRate) || inputs.hourlyRate < 0)) {
        return 'O valor da hora deve ser igual ou maior que zero.';
    }
    return '';
}

function renderPriceBreakdown(calculation) {
    const finalPriceCents = calculation.finalPriceCents;
    const rows = [
        ['laborBreakdown', calculation.breakdown.laborCents],
        ['directCostsBreakdown', calculation.breakdown.directCostsCents],
        ['taxBreakdown', calculation.breakdown.taxCents],
        ['profitBreakdown', calculation.breakdown.profitCents]
    ];

    rows.forEach(([elementId, amountCents]) => {
        const percentage = finalPriceCents
            ? amountCents / finalPriceCents * 100
            : 0;
        document.getElementById(elementId).textContent =
            `${formatCurrency(amountCents / 100)} · ${percentage.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
    });
}

function calculate() {
    const inputs = getCalculatorInputs();
    const validationError = getCalculatorValidationError(inputs);
    const markupInput = document.getElementById('markup');
    const taxInput = document.getElementById('tax');
    const totalRateInvalid = Number.isFinite(inputs.markup)
        && Number.isFinite(inputs.tax)
        && inputs.markup + inputs.tax >= 100;

    markupInput.setAttribute('aria-invalid', String(
        !Number.isFinite(inputs.markup) || inputs.markup < 0 || inputs.markup > 100 || totalRateInvalid
    ));
    taxInput.setAttribute('aria-invalid', String(
        !Number.isFinite(inputs.tax) || inputs.tax < 0 || inputs.tax > 100 || totalRateInvalid
    ));

    if (validationError) {
        lastCalculation = null;
        setCalculatorActionState(false);
        showCalculatorMessage(validationError);
        return false;
    }

    const customCosts = inputs.costs.filter((item) => item.model === inputs.businessModel);
    const laborCost = inputs.labor + customCosts
        .filter((item) => item.type === 'Mao de obra')
        .reduce((sum, item) => sum + item.value, 0);
    const directCosts = inputs.mat + customCosts
        .filter((item) => item.type !== 'Mao de obra')
        .reduce((sum, item) => sum + item.value, 0);
    const totalCost = laborCost + directCosts;
    const finalPrice = totalCost / (1 - ((inputs.markup + inputs.tax) / 100));
    const finalPriceCents = Math.round(finalPrice * 100);
    const totalCostCents = Math.round(totalCost * 100);
    const laborCents = Math.round(laborCost * 100);
    const directCostsCents = totalCostCents - laborCents;
    const taxCents = Math.round(finalPriceCents * inputs.tax / 100);
    const profitCents = finalPriceCents - totalCostCents - taxCents;

    lastCalculation = {
        name: inputs.serviceName || 'Serviço ou produto',
        inputs,
        finalPriceCents,
        totalCostCents,
        breakdown: { laborCents, directCostsCents, taxCents, profitCents },
        calculatedAt: new Date().toISOString()
    };

    animateValue('final-price', finalPriceCents / 100);
    document.getElementById('total-cost-view').textContent = formatCurrency(totalCostCents / 100);
    document.getElementById('profit-view').textContent = formatCurrency(profitCents / 100);
    renderPriceBreakdown(lastCalculation);
    showCalculatorMessage('');
    setCalculatorActionState(true);
    return true;
}

function animateValue(id, value) {
    const obj = document.getElementById(id);
    obj.innerText = value.toLocaleString('pt-BR', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

function getUsers() {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_USERS)) || [];
    } catch (error) {
        return [];
    }
}

function setUsers(users) {
    if (users.length) localStorage.setItem(STORAGE_USERS, JSON.stringify(users));
    else localStorage.removeItem(STORAGE_USERS);
}

function removeLegacyUser(email) {
    setUsers(getUsers().filter((user) => user.email?.toLowerCase() !== email.toLowerCase()));
}

function getSessionUser() {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_SESSION));
    } catch (error) {
        return null;
    }
}

function setSessionUser(user) {
    const { password, ...safeUser } = user;
    localStorage.setItem(STORAGE_SESSION, JSON.stringify(safeUser));
}

function clearSessionUser() {
    localStorage.removeItem(STORAGE_SESSION);
}

function showAuthView() {
    const authView = document.getElementById('authView');
    const appView = document.getElementById('appView');

    authView.classList.remove('hidden');
    appView.classList.add('hidden');
    loadedOwnerEmail = '';
    transactions = [];
    products = [];
    sales = [];
    teamMembers = [];
    pricingHistory = [];
    lastCalculation = null;
    editingCalculationId = null;
    if (pricingDraftTimer) window.clearTimeout(pricingDraftTimer);
    pricingDraftTimer = null;
    calculatorDraftDirty = false;
    setCalculatorActionState(false);
    renderPriceHistory();
    stopHomeSalesRefresh();
}

function showView(viewId) {
    document.querySelectorAll('.view-panel').forEach((panel) => {
        panel.classList.toggle('hidden', panel.id !== viewId);
    });
    document.querySelectorAll('.view-tab').forEach((tab) => {
        const isCurrent = tab.dataset.view === viewId;
        tab.classList.toggle('active', isCurrent);
        if (isCurrent) tab.setAttribute('aria-current', 'page');
        else tab.removeAttribute('aria-current');
    });
    if (viewId === 'dashboardView') startHomeSalesRefresh();
    else stopHomeSalesRefresh();
}

function showDashboardView() {
    showView('dashboardView');
}

function showProfileView() {
    showView('profileView');
}

async function showAppView() {
    const authView = document.getElementById('authView');
    const appView = document.getElementById('appView');

    await Promise.all([
        loadPricingHistory(),
        loadPricingDraft(),
        loadApplicationData()
    ]);
    authView.classList.add('hidden');
    appView.classList.remove('hidden');
    showDashboardView();
}

async function restoreSessionUser() {
    const storedUser = getSessionUser();
    if (!storedUser || !storedUser.email) {
        showAuthView();
        return;
    }

    try {
        let payload;
        try {
            payload = await requestTransactions(
                `/api/account?email=${encodeURIComponent(storedUser.email)}`
            );
        } catch (error) {
            if (error.status !== 404) throw error;
            const legacyUser = getUsers().find(
                (user) => user.email?.toLowerCase() === storedUser.email.toLowerCase()
            );
            const password = storedUser.password || legacyUser?.password;
            if (!password) throw new Error('Entre novamente para salvar os dados da sua conta no banco SQLite.');
            payload = await requestTransactions('/api/auth/register', {
                method: 'POST',
                body: JSON.stringify({
                    name: storedUser.name || legacyUser?.name || storedUser.email.split('@')[0],
                    document: storedUser.document || legacyUser?.document || 'Não informado',
                    email: storedUser.email,
                    phone: storedUser.phone || legacyUser?.phone || '',
                    address: storedUser.address || legacyUser?.address || '',
                    password
                })
            });
        }

        setSessionUser(payload.user);
        removeLegacyUser(payload.user.email);
        await showAppView();
        renderProfileForm();
    } catch (error) {
        console.error('Não foi possível restaurar a conta do banco SQLite.', error);
        clearSessionUser();
        showAuthView();
        alert(`Não foi possível carregar sua conta: ${error.message}`);
    }
}

function initAuthTabs() {
    const authTabs = document.querySelectorAll('.auth-tab');
    const authForms = document.querySelectorAll('.auth-form');

    authTabs.forEach((tab) => {
        tab.addEventListener('click', () => {
            const target = tab.dataset.auth;
            authTabs.forEach((button) => button.classList.toggle('active', button === tab));
            authForms.forEach((form) => form.classList.toggle('active', form.id === `${target}Form`));
        });
    });
}

function renderProfileForm() {
    const user = getSessionUser();
    if (!user) return;

    document.getElementById('welcomeUser').textContent = `Olá, ${user.name ? user.name.split(' ')[0] : 'usuário'}`;
    document.getElementById('profileName').value = user.name || '';
    document.getElementById('profileDocument').value = user.document || '';
    document.getElementById('profileEmail').value = user.email || '';
    document.getElementById('profilePhone').value = user.phone || '';
    document.getElementById('profileAddress').value = user.address || '';
}

async function authenticateAccount(email, password) {
    let accountExists = false;
    try {
        await requestTransactions(`/api/account?email=${encodeURIComponent(email)}`);
        accountExists = true;
    } catch (error) {
        if (error.status !== 404) throw error;
    }

    if (accountExists) {
        const payload = await requestTransactions('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email, password })
        });
        return payload.user;
    }

    const legacyUser = getUsers().find((user) => user.email?.toLowerCase() === email);
    const fallbackName = email.split('@')[0].replace(/[._-]/g, ' ');
    const payload = await requestTransactions('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({
            name: legacyUser?.name || fallbackName,
            document: legacyUser?.document || 'Não informado',
            email,
            phone: legacyUser?.phone || '',
            address: legacyUser?.address || '',
            password
        })
    });
    return payload.user;
}

async function handleLogin(event) {
    event.preventDefault();

    const email = document.getElementById('loginEmail').value.trim().toLowerCase();
    const password = document.getElementById('loginPassword').value.trim();

    if (!email || !password) {
        alert('Preencha e-mail e senha para continuar.');
        return;
    }

    try {
        const user = await authenticateAccount(email, password);
        setSessionUser(user);
        removeLegacyUser(user.email);
        await showAppView();
        renderProfileForm();
        document.getElementById('loginForm').reset();
    } catch (error) {
        alert(`Não foi possível entrar: ${error.message}`);
    }
}

async function handleRegister(event) {
    event.preventDefault();

    const name = document.getElementById('registerName').value.trim();
    const documentValue = document.getElementById('registerDocument').value.trim();
    const email = document.getElementById('registerEmail').value.trim().toLowerCase();
    const password = document.getElementById('registerPassword').value.trim();
    const confirmPassword = document.getElementById('registerConfirmPassword').value.trim();

    if (!name || !documentValue || !email || !password || !confirmPassword) {
        alert('Preencha todos os campos do cadastro.');
        return;
    }

    if (password !== confirmPassword) {
        alert('As senhas não conferem.');
        return;
    }

    try {
        const payload = await requestTransactions('/api/auth/register', {
            method: 'POST',
            body: JSON.stringify({
                name,
                document: documentValue,
                email,
                password,
                phone: '',
                address: ''
            })
        });
        setSessionUser(payload.user);
        removeLegacyUser(payload.user.email);
        document.getElementById('registerForm').reset();
        await showAppView();
        renderProfileForm();
        alert('Cadastro realizado com sucesso!');
    } catch (error) {
        alert(`Não foi possível cadastrar: ${error.message}`);
    }
}

async function handleUpdateProfile() {
    const currentUser = getSessionUser();
    if (!currentUser) {
        alert('Faça login para atualizar o cadastro.');
        return;
    }

    const profile = {
        currentEmail: currentUser.email,
        name: document.getElementById('profileName').value.trim(),
        document: document.getElementById('profileDocument').value.trim(),
        email: document.getElementById('profileEmail').value.trim().toLowerCase(),
        phone: document.getElementById('profilePhone').value.trim(),
        address: document.getElementById('profileAddress').value.trim()
    };

    if (!profile.name || !profile.document || !profile.email) {
        alert('Nome, documento e e-mail são obrigatórios.');
        return;
    }

    try {
        await flushPricingDraftSave();
        const payload = await requestTransactions('/api/account', {
            method: 'PUT',
            body: JSON.stringify(profile)
        });
        setSessionUser(payload.user);
        renderProfileForm();
        showDashboardView();
        await Promise.all([loadApplicationData(), loadPricingHistory(), loadPricingDraft()]);
        alert('Cadastro atualizado com sucesso!');
    } catch (error) {
        alert(`Não foi possível atualizar o cadastro: ${error.message}`);
    }
}

async function handleLogout() {
    try {
        await flushPricingDraftSave();
    } catch (error) {
        alert(`Não foi possível salvar o rascunho antes de sair: ${error.message}`);
        return;
    }
    clearSessionUser();
    showAuthView();
    document.getElementById('loginForm').reset();
    document.getElementById('registerForm').reset();
}

function populateFilters() {
    const monthFilter = document.getElementById('monthFilter');

    months.forEach((month) => {
        const option = document.createElement('option');
        option.value = month;
        option.textContent = month;
        monthFilter.appendChild(option);
    });
}

function populateYearFilter() {
    const yearFilter = document.getElementById('yearFilter');
    const selectedYear = yearFilter.value || 'todos';
    const uniqueYears = [...new Set([
        new Date().getFullYear(),
        ...transactions.map((item) => Number(item.date.slice(0, 4)))
    ])].sort((a, b) => b - a);

    yearFilter.replaceChildren(new Option('Todos', 'todos'));
    uniqueYears.forEach((year) => {
        const option = document.createElement('option');
        option.value = year;
        option.textContent = year;
        yearFilter.appendChild(option);
    });

    yearFilter.value = [...yearFilter.options].some((option) => option.value === selectedYear)
        ? selectedYear
        : 'todos';
}

function getFilteredTransactions() {
    const monthFilter = document.getElementById('monthFilter');
    const yearFilter = document.getElementById('yearFilter');
    const typeFilter = document.getElementById('typeFilter');
    const selectedMonth = monthFilter.value;
    const selectedYear = yearFilter.value;
    const selectedType = typeFilter.value;

    return transactions.filter((item) => {
        const transactionMonth = months[Number(item.date.slice(5, 7)) - 1];
        const matchesMonth = selectedMonth === 'todos' || transactionMonth === selectedMonth;
        const matchesYear = selectedYear === 'todos' || item.date.startsWith(`${selectedYear}-`);
        const matchesType = selectedType === 'todas' || item.type === selectedType;
        return matchesMonth && matchesYear && matchesType;
    });
}

function formatCurrency(value) {
    return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function showTransactionMessage(message, isError = false) {
    const messageElement = document.getElementById('transactionMessage');
    messageElement.textContent = message;
    messageElement.classList.toggle('hidden', !message);
    messageElement.classList.toggle('error', isError);
}

async function requestTransactions(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...options.headers
        }
    });
    const payload = await response.json();

    if (!response.ok) {
        const error = new Error(payload.error || 'Não foi possível concluir a operação.');
        error.status = response.status;
        throw error;
    }

    return payload;
}

function getCurrentUserEmail() {
    const user = getSessionUser();
    return user && user.email ? user.email.trim().toLowerCase() : '';
}

function getPricingHistoryStorageKey() {
    const email = getCurrentUserEmail();
    return email ? `infinity_pricing_history_${email}` : '';
}

function showPricingDraftMessage(message, isError = false) {
    const element = document.getElementById('pricingDraftMessage');
    element.textContent = message;
    element.classList.toggle('hidden', !message);
    element.classList.toggle('error', isError);
}

function getCalculatorDraft() {
    return {
        serviceName: document.getElementById('serviceName').value,
        hourlyRate: document.getElementById('hourlyRate').value,
        mat: document.getElementById('mat').value,
        labor: document.getElementById('labor').value,
        markup: document.getElementById('markup').value,
        tax: document.getElementById('tax').value,
        businessModel: document.getElementById('businessModel').value,
        costs: registeredCosts.map((item) => ({ ...item, value: String(item.value) }))
    };
}

function schedulePricingDraftSave() {
    if (!getCurrentUserEmail()) return;
    calculatorDraftDirty = true;
    if (pricingDraftTimer) window.clearTimeout(pricingDraftTimer);
    pricingDraftTimer = window.setTimeout(() => {
        pricingDraftTimer = null;
        const email = getCurrentUserEmail();
        const draft = getCalculatorDraft();
        enqueuePricingDraftSave(email, draft)
            .then(() => {
                if (email === getCurrentUserEmail()) {
                    showPricingDraftMessage('Rascunho salvo no banco SQLite.');
                }
            })
            .catch((error) => showPricingDraftError(email, error));
    }, 500);
}

function enqueuePricingDraftSave(email, draft) {
    const request = pricingDraftSaveQueue
        .catch(() => {})
        .then(() => requestTransactions('/api/pricing-draft', {
            method: 'PUT',
            body: JSON.stringify({ email, draft })
        }));
    pricingDraftSaveQueue = request;
    return request;
}

function showPricingDraftError(email, error) {
    console.error('Não foi possível salvar o rascunho no SQLite.', error);
    if (email === getCurrentUserEmail()) {
        showPricingDraftMessage(`Não foi possível salvar o rascunho: ${error.message}`, true);
    }
}

async function flushPricingDraftSave() {
    if (pricingDraftTimer) window.clearTimeout(pricingDraftTimer);
    pricingDraftTimer = null;
    const email = getCurrentUserEmail();
    if (!email) return;
    try {
        await enqueuePricingDraftSave(email, getCalculatorDraft());
        showPricingDraftMessage('Rascunho salvo no banco SQLite.');
    } catch (error) {
        showPricingDraftError(email, error);
        throw error;
    }
}

async function loadPricingDraft() {
    try {
        const payload = await requestTransactions(getApiUrl('/api/pricing-draft'));
        if (!payload.draft || calculatorDraftDirty) return;
        const draft = payload.draft;
        document.getElementById('serviceName').value = draft.serviceName || '';
        document.getElementById('hourlyRate').value = draft.hourlyRate || '';
        document.getElementById('mat').value = draft.mat || '';
        document.getElementById('labor').value = draft.labor || '';
        document.getElementById('markup').value = draft.markup || '';
        document.getElementById('tax').value = draft.tax || '';
        document.getElementById('businessModel').value = draft.businessModel;
        registeredCosts = draft.costs.map((item) => ({ ...item, value: Number(item.value) }));
        renderCostTable();
        calculate();
        calculatorDraftDirty = false;
        showPricingDraftMessage('Rascunho carregado do banco SQLite.');
    } catch (error) {
        console.error('Não foi possível carregar o rascunho do SQLite.', error);
        showPricingDraftMessage(`Não foi possível carregar o rascunho salvo: ${error.message}`, true);
    }
}

function showPriceHistoryMessage(message, isError = false) {
    const element = document.getElementById('priceHistoryMessage');
    element.textContent = message;
    element.classList.toggle('hidden', !message);
    element.classList.toggle('error', isError);
}

function renderPriceHistory() {
    const list = document.getElementById('priceHistoryList');
    list.replaceChildren();

    if (!pricingHistory.length) {
        list.appendChild(makeElement('p', 'empty-state', 'Os cálculos salvos aparecerão aqui.'));
        return;
    }

    [...pricingHistory]
        .sort((left, right) => new Date(right.updatedAt || right.createdAt) - new Date(left.updatedAt || left.createdAt))
        .forEach((calculation) => {
            const item = makeElement('article', 'price-history-item');
            const details = makeElement('div', 'price-history-details');
            const updatedAt = new Date(calculation.updatedAt || calculation.createdAt);
            const dateLabel = Number.isNaN(updatedAt.getTime())
                ? 'Data não disponível'
                : updatedAt.toLocaleString('pt-BR');

            details.append(
                makeElement('strong', 'price-history-name', calculation.name || 'Serviço ou produto'),
                makeElement('span', 'price-history-meta', `${dateLabel} · ${formatCurrency(calculation.finalPriceCents / 100)}`)
            );

            const actions = makeElement('div', 'price-history-actions');
            const editButton = makeElement('button', 'secondary-btn small-btn', 'Editar');
            editButton.type = 'button';
            editButton.dataset.action = 'edit-calculation';
            editButton.dataset.id = String(calculation.id);
            const exportButton = makeElement('button', 'secondary-btn small-btn', 'Exportar PDF');
            exportButton.type = 'button';
            exportButton.dataset.action = 'export-calculation';
            exportButton.dataset.id = String(calculation.id);
            actions.append(editButton, exportButton);
            item.append(details, actions);
            list.appendChild(item);
        });
}

async function loadPricingHistory() {
    const key = getPricingHistoryStorageKey();
    if (!key) {
        pricingHistory = [];
        renderPriceHistory();
        return;
    }

    let migrationError = '';
    const storedHistory = localStorage.getItem(key);
    if (storedHistory) {
        try {
            const legacyHistory = JSON.parse(storedHistory);
            if (!Array.isArray(legacyHistory)) {
                throw new Error('O histórico local não possui o formato esperado.');
            }
            if (legacyHistory.length) {
                await requestTransactions('/api/calculations/import', {
                    method: 'POST',
                    body: JSON.stringify({
                        email: getCurrentUserEmail(),
                        calculations: legacyHistory
                    })
                });
            }
            localStorage.removeItem(key);
        } catch (error) {
            console.error('Não foi possível migrar o histórico antigo para o SQLite.', error);
            migrationError = `Não foi possível migrar o histórico antigo: ${error.message}. Os dados locais foram mantidos.`;
        }
    }

    try {
        const payload = await requestTransactions(getApiUrl('/api/calculations'));
        pricingHistory = payload.calculations;
        renderPriceHistory();
        showPriceHistoryMessage(migrationError, Boolean(migrationError));
    } catch (error) {
        console.error('Não foi possível carregar o histórico do SQLite.', error);
        pricingHistory = [];
        renderPriceHistory();
        showPriceHistoryMessage(
            migrationError || `Não foi possível carregar o histórico do banco SQLite: ${error.message}`,
            true
        );
    }
}

function applyPricingCalculation(calculation) {
    const inputs = calculation.inputs;
    document.getElementById('serviceName').value = inputs.serviceName || '';
    document.getElementById('hourlyRate').value = inputs.hourlyRate ?? '';
    document.getElementById('mat').value = inputs.mat;
    document.getElementById('labor').value = inputs.labor;
    document.getElementById('markup').value = inputs.markup;
    document.getElementById('tax').value = inputs.tax;
    document.getElementById('businessModel').value = inputs.businessModel;
    registeredCosts = Array.isArray(inputs.costs) ? inputs.costs.map((item) => ({ ...item })) : [];
    renderCostTable();
}

function editPricingCalculation(id) {
    const calculation = pricingHistory.find((item) => String(item.id) === String(id));
    if (!calculation) {
        showPriceHistoryMessage('O cálculo selecionado não foi encontrado no histórico.', true);
        return;
    }

    editingCalculationId = calculation.id;
    applyPricingCalculation(calculation);
    document.getElementById('saveCalculationBtn').textContent = 'Salvar alterações';
    document.getElementById('cancelCalculationEditBtn').classList.remove('hidden');
    calculate();
    schedulePricingDraftSave();
    showPriceHistoryMessage(`Editando "${calculation.name}". O histórico só será alterado ao salvar.`, false);
}

function cancelPricingCalculationEdit() {
    const original = pricingHistory.find((item) => String(item.id) === String(editingCalculationId));
    editingCalculationId = null;
    document.getElementById('saveCalculationBtn').textContent = 'Salvar no histórico';
    document.getElementById('cancelCalculationEditBtn').classList.add('hidden');
    if (original) {
        applyPricingCalculation(original);
        calculate();
        schedulePricingDraftSave();
        showPriceHistoryMessage('Edição cancelada. O cálculo original foi mantido.', false);
    }
}

async function savePricingCalculation() {
    if (!lastCalculation) {
        showCalculatorMessage('Atualize os cálculos antes de salvar.');
        return;
    }

    const payload = {
        email: getCurrentUserEmail(),
        name: lastCalculation.name,
        inputs: lastCalculation.inputs
    };
    const editingId = editingCalculationId;
    try {
        const result = await requestTransactions(
            editingId === null ? '/api/calculations' : `/api/calculations/${editingId}`,
            {
                method: editingId === null ? 'POST' : 'PUT',
                body: JSON.stringify(payload)
            }
        );
        const savedCalculation = result.calculation;
        lastCalculation = savedCalculation;
        if (editingId === null) pricingHistory = [savedCalculation, ...pricingHistory];
        else pricingHistory = pricingHistory.map((item) => (
            String(item.id) === String(editingId) ? savedCalculation : item
        ));
        editingCalculationId = null;
        document.getElementById('saveCalculationBtn').textContent = 'Salvar no histórico';
        document.getElementById('cancelCalculationEditBtn').classList.add('hidden');
        animateValue('final-price', savedCalculation.finalPriceCents / 100);
        document.getElementById('total-cost-view').textContent = formatCurrency(savedCalculation.totalCostCents / 100);
        document.getElementById('profit-view').textContent =
            formatCurrency(savedCalculation.breakdown.profitCents / 100);
        renderPriceBreakdown(savedCalculation);
        renderPriceHistory();
        showPriceHistoryMessage('Cálculo salvo no banco SQLite.', false);
    } catch (error) {
        showPriceHistoryMessage(`Não foi possível salvar o cálculo no banco SQLite: ${error.message}`, true);
    }
}

function exportPricingCalculation(calculation) {
    if (!calculation) {
        showCalculatorMessage('Atualize os cálculos antes de exportar.');
        return;
    }

    const sheet = document.getElementById('pricePrintSheet');
    sheet.replaceChildren();
    sheet.append(
        makeElement('h1', '', 'Infinity Price'),
        makeElement('p', 'price-print-subtitle', 'Detalhamento do preço')
    );

    const details = makeElement('dl', 'price-print-details');
    const detailRows = [
        ['Serviço ou produto', calculation.name || 'Serviço ou produto'],
        ['Valor da hora (informativo)', calculation.inputs.hourlyRate === null
            ? 'Não informado'
            : formatCurrency(calculation.inputs.hourlyRate)]
    ];
    detailRows.forEach(([label, value]) => {
        details.append(makeElement('dt', '', label), makeElement('dd', '', value));
    });
    sheet.appendChild(details);

    const table = document.createElement('table');
    table.className = 'price-print-table';
    const body = document.createElement('tbody');
    const rows = [
        ['Mão de obra', calculation.breakdown.laborCents],
        ['Custos diretos', calculation.breakdown.directCostsCents],
        ['Taxas e impostos', calculation.breakdown.taxCents],
        ['Lucro', calculation.breakdown.profitCents]
    ];
    rows.forEach(([label, amountCents]) => {
        const row = document.createElement('tr');
        const percentage = calculation.finalPriceCents
            ? amountCents / calculation.finalPriceCents * 100
            : 0;
        row.append(
            makeElement('th', '', label),
            makeElement('td', '', formatCurrency(amountCents / 100)),
            makeElement('td', '', `${percentage.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`)
        );
        body.appendChild(row);
    });
    const total = document.createElement('tr');
    total.className = 'price-print-total';
    total.append(
        makeElement('th', '', 'Preço sugerido'),
        makeElement('td', '', formatCurrency(calculation.finalPriceCents / 100)),
        makeElement('td', '', '100%')
    );
    body.appendChild(total);
    table.appendChild(body);
    sheet.appendChild(table);

    const note = makeElement('p', 'price-print-note', 'O valor da hora é informativo e não altera o cálculo do preço.');
    sheet.appendChild(note);
    window.print();
}

async function loadTransactions() {
    const email = getCurrentUserEmail();
    if (!email) return;

    showTransactionMessage('Carregando movimentações...');
    try {
        const payload = await requestTransactions(`/api/transactions?email=${encodeURIComponent(email)}`);
        transactions = payload.transactions;
        populateYearFilter();
        renderTransactionTable();
        renderOverview();
        showTransactionMessage('');
    } catch (error) {
        showTransactionMessage(`Erro ao carregar movimentações: ${error.message}`, true);
    }
}

async function addTransaction(event) {
    event.preventDefault();
    const email = getCurrentUserEmail();
    if (!email) {
        showTransactionMessage('Entre na sua conta para registrar uma movimentação.', true);
        return;
    }

    const form = document.getElementById('transactionForm');
    const payload = {
        email,
        type: document.getElementById('transactionType').value,
        description: document.getElementById('transactionDescription').value.trim(),
        category: document.getElementById('transactionCategory').value,
        amount: Number(document.getElementById('transactionAmount').value),
        date: document.getElementById('transactionDate').value,
        status: document.getElementById('transactionStatus').value
    };

    try {
        await requestTransactions('/api/transactions', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        form.reset();
        document.getElementById('transactionDate').value = getTodayDate();
        await loadTransactions();
        showTransactionMessage('Movimentação registrada com sucesso.');
    } catch (error) {
        showTransactionMessage(`Erro ao registrar movimentação: ${error.message}`, true);
    }
}

async function removeTransaction(id) {
    if (!window.confirm('Deseja excluir esta movimentação?')) return;
    const email = getCurrentUserEmail();
    if (!email) {
        showTransactionMessage('Entre na sua conta para excluir uma movimentação.', true);
        return;
    }

    try {
        await requestTransactions(
            `/api/transactions/${id}?email=${encodeURIComponent(email)}`,
            { method: 'DELETE' }
        );
        await loadTransactions();
        showTransactionMessage('Movimentação excluída com sucesso.');
    } catch (error) {
        showTransactionMessage(`Erro ao excluir movimentação: ${error.message}`, true);
    }
}

function renderTransactionTable() {
    const rows = getFilteredTransactions();
    const body = document.getElementById('transactionTableBody');
    const totals = rows.reduce((summary, item) => {
        const amountCents = Math.round(item.amount * 100);
        if (item.status === 'pendente') {
            summary.pending += amountCents;
        } else if (item.type === 'entrada') {
            summary.income += amountCents;
        } else {
            summary.expenses += amountCents;
        }
        return summary;
    }, { income: 0, expenses: 0, pending: 0 });

    document.getElementById('totalEntradas').textContent = formatCurrency(totals.income / 100);
    document.getElementById('totalSaidas').textContent = formatCurrency(totals.expenses / 100);
    document.getElementById('saldoFinanceiro').textContent = formatCurrency((totals.income - totals.expenses) / 100);
    document.getElementById('totalPendente').textContent = formatCurrency(totals.pending / 100);
    body.replaceChildren();

    if (!rows.length) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 7;
        cell.className = 'empty-state';
        cell.textContent = 'Nenhuma movimentação encontrada para esse filtro.';
        row.appendChild(cell);
        body.appendChild(row);
        return;
    }

    rows.forEach((item) => {
        const row = document.createElement('tr');
        const values = [
            item.date.split('-').reverse().join('/'),
            item.type === 'entrada' ? 'Entrada' : 'Saída',
            item.description,
            item.category,
            item.status === 'pendente'
                ? (item.type === 'entrada' ? 'A receber' : 'A pagar')
                : (item.type === 'entrada' ? 'Recebido' : 'Pago'),
            formatCurrency(item.amount)
        ];

        values.forEach((value, index) => {
            const cell = document.createElement('td');
            cell.textContent = value;
            if (index === 1) cell.className = item.type === 'entrada' ? 'transaction-income' : 'transaction-expense';
            if (index === 4) cell.className = item.status === 'pendente' ? 'transaction-pending' : 'transaction-confirmed';
            row.appendChild(cell);
        });

        const actionCell = document.createElement('td');
        if (item.source_type === 'manual') {
            const deleteButton = document.createElement('button');
            deleteButton.type = 'button';
            deleteButton.className = 'remove-cost-btn';
            deleteButton.textContent = 'Excluir';
            deleteButton.setAttribute('aria-label', `Excluir movimentação: ${item.description}`);
            deleteButton.addEventListener('click', () => removeTransaction(item.id));
            actionCell.appendChild(deleteButton);
        } else {
            actionCell.textContent = 'Venda';
            actionCell.className = 'transaction-source';
        }
        row.appendChild(actionCell);
        body.appendChild(row);
    });
}

function exportExcel() {
    const rows = getFilteredTransactions();
    const header = ['Data', 'Tipo', 'Descrição', 'Categoria', 'Situação', 'Valor'];
    const toCsvCell = (value) => {
        const text = String(value);
        const safeText = /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
        return `"${safeText.replace(/"/g, '""')}"`;
    };
    const csvRows = [header.map(toCsvCell).join(';')];

    rows.forEach((item) => {
        const status = item.status === 'pendente'
            ? (item.type === 'entrada' ? 'A receber' : 'A pagar')
            : (item.type === 'entrada' ? 'Recebido' : 'Pago');
        const values = [
            item.date.split('-').reverse().join('/'),
            item.type === 'entrada' ? 'Entrada' : 'Saída',
            item.description,
            item.category,
            status,
            item.amount.toFixed(2).replace('.', ',')
        ];
        csvRows.push(values.map(toCsvCell).join(';'));
    });

    const csvContent = csvRows.join('\n');
    const blob = new Blob(['\uFEFF', csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = url;
    link.download = `movimentacoes_${getTodayDate()}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

function exportPdf() {
    window.print();
}

function addCostItem() {
    const name = document.getElementById('costName').value.trim();
    const type = document.getElementById('costType').value;
    const value = parseFloat(document.getElementById('costValue').value) || 0;

    if (!name || value <= 0) {
        alert('Preencha a descrição e o valor do item antes de adicionar.');
        return;
    }

    registeredCosts.push({
        id: Date.now() + Math.random(),
        name,
        type,
        value,
        model: document.getElementById('businessModel').value
    });

    document.getElementById('costName').value = '';
    document.getElementById('costValue').value = '';
    renderCostTable();
    calculate();
    schedulePricingDraftSave();
}

function removeCostItem(id) {
    registeredCosts = registeredCosts.filter((item) => String(item.id) !== String(id));
    renderCostTable();
    calculate();
    schedulePricingDraftSave();
}

function renderCostTable() {
    const body = document.getElementById('costTableBody');
    if (!body) return;

    body.innerHTML = '';

    if (!registeredCosts.length) {
        body.innerHTML = '<tr><td colspan="4" class="empty-state">Nenhum item cadastrado.</td></tr>';
        return;
    }

    registeredCosts.forEach((item) => {
        const row = document.createElement('tr');
        const name = document.createElement('td');
        name.textContent = item.name;
        const type = document.createElement('td');
        type.textContent = item.type;
        const value = document.createElement('td');
        value.textContent = formatCurrency(item.value);
        const action = document.createElement('td');
        const removeButton = makeElement('button', 'remove-cost-btn', 'Excluir');
        removeButton.type = 'button';
        removeButton.dataset.id = String(item.id);
        action.appendChild(removeButton);
        row.append(name, type, value, action);
        body.appendChild(row);
    });

    document.querySelectorAll('.remove-cost-btn').forEach((button) => {
        button.addEventListener('click', () => removeCostItem(button.dataset.id));
    });
}

function getCurrentTotalCost() {
    const mat = parseFloat(document.getElementById('mat').value) || 0;
    const labor = parseFloat(document.getElementById('labor').value) || 0;
    const businessModel = document.getElementById('businessModel')?.value || 'produto';

    const customCosts = registeredCosts.filter((item) => item.model === businessModel);
    const customTotal = customCosts.reduce((sum, item) => sum + item.value, 0);

    return mat + labor + customTotal;
}

function initCostControls() {
    const addCostBtn = document.getElementById('addCostBtn');
    const businessModel = document.getElementById('businessModel');

    if (addCostBtn) {
        addCostBtn.addEventListener('click', addCostItem);
    }

    if (businessModel) {
        businessModel.addEventListener('change', () => {
            renderCostTable();
            calculate();
            schedulePricingDraftSave();
        });
    }
}

function markCalculatorAsChanged() {
    calculatorDraftDirty = true;
    lastCalculation = null;
    setCalculatorActionState(false);
    showCalculatorMessage('Os dados foram alterados. Atualize os cálculos antes de salvar ou exportar.');
    schedulePricingDraftSave();
}

function initCalculatorControls() {
    ['serviceName', 'hourlyRate', 'mat', 'labor', 'markup', 'tax'].forEach((id) => {
        document.getElementById(id).addEventListener('input', markCalculatorAsChanged);
    });

    document.getElementById('saveCalculationBtn').addEventListener('click', savePricingCalculation);
    document.getElementById('cancelCalculationEditBtn').addEventListener('click', cancelPricingCalculationEdit);
    document.getElementById('exportCalculationBtn').addEventListener('click', () => {
        exportPricingCalculation(lastCalculation);
    });
    document.getElementById('priceHistoryList').addEventListener('click', (event) => {
        const button = event.target.closest('button[data-action]');
        if (!button) return;
        const calculation = pricingHistory.find((item) => String(item.id) === button.dataset.id);
        if (!calculation) {
            showPriceHistoryMessage('O cálculo selecionado não foi encontrado no histórico.', true);
            return;
        }

        if (button.dataset.action === 'edit-calculation') editPricingCalculation(calculation.id);
        if (button.dataset.action === 'export-calculation') exportPricingCalculation(calculation);
    });
}

function makeElement(tag, className = '', text = '') {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
}

function showFormMessage(id, message, isError = false) {
    const element = document.getElementById(id);
    element.textContent = message;
    element.classList.toggle('hidden', !message);
    element.classList.toggle('error', isError);
}

function showListMessage(id, message, isError = false) {
    const list = document.getElementById(id);
    list.replaceChildren();
    const empty = makeElement('div', 'empty-list');
    const icon = makeElement('i', isError ? 'fas fa-circle-exclamation' : 'fas fa-box-open');
    icon.setAttribute('aria-hidden', 'true');
    empty.append(icon, document.createTextNode(message));
    if (isError) empty.setAttribute('role', 'alert');
    list.appendChild(empty);
}

function buildActionButton(label, action, id, className = 'icon-button') {
    const button = makeElement('button', className, label);
    button.type = 'button';
    button.dataset.action = action;
    button.dataset.id = id;
    return button;
}

function getApiUrl(path) {
    const email = getCurrentUserEmail();
    return `${path}?email=${encodeURIComponent(email)}`;
}

async function loadApplicationData() {
    const email = getCurrentUserEmail();
    if (!email) return;
    if (loadedOwnerEmail !== email) {
        loadedOwnerEmail = email;
        transactions = [];
        products = [];
        sales = [];
        teamMembers = [];
        populateYearFilter();
        renderTransactionTable();
        renderProducts();
        renderProductOptions();
        renderSales();
        renderTeamMembers();
        renderOverview();
    }
    await Promise.all([
        loadTransactions(),
        loadProducts(),
        loadSales(),
        loadTeamMembers()
    ]);
    renderOverview();
}

async function loadProducts() {
    try {
        const payload = await requestTransactions(getApiUrl('/api/products'));
        products = payload.products;
        renderProducts();
        renderProductOptions();
        renderOverview();
    } catch (error) {
        products = [];
        renderProducts();
        renderProductOptions();
        showListMessage('productList', `Erro ao carregar catálogo: ${error.message}`, true);
        renderOverview();
    }
}

function renderProducts() {
    const list = document.getElementById('productList');
    const search = document.getElementById('productSearch').value.trim().toLocaleLowerCase('pt-BR');
    const filtered = products.filter((product) => (
        `${product.name} ${product.category} ${product.description}`.toLocaleLowerCase('pt-BR').includes(search)
    ));
    document.getElementById('productCount').textContent = String(products.length);
    list.replaceChildren();

    if (!filtered.length) {
        showListMessage(
            'productList',
            products.length ? 'Nenhum item corresponde à busca.' : 'Seu catálogo está vazio. Cadastre um produto ou serviço para começar.'
        );
        return;
    }

    filtered.forEach((product) => {
        const card = makeElement('article', 'product-card');
        const details = makeElement('div');
        const heading = makeElement('div', 'product-card-heading');
        heading.append(
            makeElement('h4', '', product.name),
            makeElement('span', 'kind-badge', product.kind === 'produto' ? 'Produto' : 'Serviço')
        );
        details.appendChild(heading);
        if (product.description) details.appendChild(makeElement('p', 'product-description', product.description));

        const meta = makeElement('div', 'product-meta', product.category);
        if (product.kind === 'produto') {
            const stockLabel = product.stock === null ? 'Estoque ilimitado' : `Estoque: ${product.stock}`;
            const stockClass = product.stock !== null && product.stock <= 5 ? 'stock-badge stock-low' : 'stock-badge';
            meta.appendChild(makeElement('span', stockClass, stockLabel));
        }
        details.appendChild(meta);

        const price = makeElement('strong', 'product-price', formatCurrency(product.price));
        const footer = makeElement('div', 'product-card-footer');
        const actions = makeElement('div', 'item-actions');
        actions.append(
            buildActionButton('Editar', 'edit-product', product.id, 'icon-button'),
            buildActionButton('Excluir', 'delete-product', product.id, 'icon-button danger')
        );
        footer.append(price, actions);
        card.append(details, footer);
        list.appendChild(card);
    });
}

function resetProductForm() {
    document.getElementById('productForm').reset();
    document.getElementById('productId').value = '';
    document.getElementById('productFormTitle').textContent = 'Adicionar ao catálogo';
    document.getElementById('productSubmit').innerHTML = '<i class="fas fa-plus"></i> Salvar item';
    document.getElementById('cancelProductEdit').classList.add('hidden');
    updateProductStockField();
    showFormMessage('productMessage', '');
}

function updateProductStockField() {
    const isProduct = document.getElementById('productKind').value === 'produto';
    const stockField = document.getElementById('productStockField');
    stockField.classList.toggle('hidden', !isProduct);
    document.getElementById('productStock').required = false;
    if (!isProduct) document.getElementById('productStock').value = '';
}

function editProduct(productId) {
    const product = products.find((item) => item.id === productId);
    if (!product) return;
    document.getElementById('productId').value = String(product.id);
    document.getElementById('productKind').value = product.kind;
    document.getElementById('productName').value = product.name;
    document.getElementById('productCategory').value = product.category;
    document.getElementById('productDescription').value = product.description;
    document.getElementById('productPrice').value = product.price;
    document.getElementById('productStock').value = product.stock === null ? '' : product.stock;
    document.getElementById('productFormTitle').textContent = 'Editar item do catálogo';
    document.getElementById('productSubmit').innerHTML = '<i class="fas fa-check"></i> Salvar alterações';
    document.getElementById('cancelProductEdit').classList.remove('hidden');
    updateProductStockField();
    document.getElementById('productForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function saveProduct(event) {
    event.preventDefault();
    const productId = document.getElementById('productId').value;
    const stockValue = document.getElementById('productStock').value;
    const payload = {
        email: getCurrentUserEmail(),
        kind: document.getElementById('productKind').value,
        name: document.getElementById('productName').value.trim(),
        category: document.getElementById('productCategory').value.trim(),
        description: document.getElementById('productDescription').value.trim(),
        price: Number(document.getElementById('productPrice').value),
        stock: document.getElementById('productKind').value === 'produto' && stockValue !== ''
            ? Number(stockValue)
            : null
    };

    try {
        await requestTransactions(productId ? `/api/products/${productId}` : '/api/products', {
            method: productId ? 'PUT' : 'POST',
            body: JSON.stringify(payload)
        });
        resetProductForm();
        await Promise.all([loadProducts(), loadSales()]);
        showFormMessage('productMessage', 'Item salvo com sucesso.');
    } catch (error) {
        showFormMessage('productMessage', `Erro ao salvar item: ${error.message}`, true);
    }
}

async function deleteProduct(productId) {
    if (!window.confirm('Deseja remover este item do catálogo?')) return;
    try {
        await requestTransactions(`/api/products/${productId}?email=${encodeURIComponent(getCurrentUserEmail())}`, {
            method: 'DELETE'
        });
        await loadProducts();
        showFormMessage('productMessage', 'Item removido do catálogo.');
    } catch (error) {
        showFormMessage('productMessage', `Erro ao remover item: ${error.message}`, true);
    }
}

async function loadSales() {
    try {
        const payload = await requestTransactions(getApiUrl('/api/sales'));
        sales = payload.sales;
        renderSales();
        renderOverview();
    } catch (error) {
        sales = [];
        renderSales();
        showListMessage('salesList', `Erro ao carregar vendas: ${error.message}`, true);
        showListMessage('recentSales', `Erro ao carregar vendas: ${error.message}`, true);
        renderOverview();
    }
}

function getSelectedProduct() {
    return products.find((product) => String(product.id) === document.getElementById('saleProduct').value);
}

function renderProductOptions() {
    const select = document.getElementById('saleProduct');
    const selected = select.value;
    select.replaceChildren(new Option('Escolha no catálogo', ''));
    products.forEach((product) => {
        const stockNote = product.kind === 'produto' && product.stock !== null ? ` · estoque ${product.stock}` : '';
        const option = new Option(`${product.name} · ${formatCurrency(product.price)}${stockNote}`, String(product.id));
        option.disabled = product.kind === 'produto' && product.stock === 0;
        select.appendChild(option);
    });
    select.appendChild(new Option('Venda avulsa (sem catálogo)', 'avulsa'));
    if ([...select.options].some((option) => option.value === selected)) select.value = selected;
    updateSalePreview();
}

function updateSalePreview() {
    const selectedValue = document.getElementById('saleProduct').value;
    const product = getSelectedProduct();
    const quantityInput = document.getElementById('saleQuantity');
    const hint = document.getElementById('saleStockHint');
    const customFields = document.getElementById('saleCustomFields');
    const isCustomSale = selectedValue === 'avulsa';
    const quantity = Math.max(1, Number(quantityInput.value) || 1);
    const customName = document.getElementById('saleItemName');
    const customPrice = document.getElementById('saleUnitPrice');
    customFields.classList.toggle('hidden', !isCustomSale);
    customName.required = isCustomSale;
    customPrice.required = isCustomSale;

    if (isCustomSale) {
        quantityInput.removeAttribute('max');
        hint.textContent = 'Este item não será salvo no catálogo e não altera o estoque.';
        hint.classList.remove('hidden');
        document.getElementById('saleTotal').textContent = formatCurrency(
            (Number(customPrice.value) || 0) * quantity
        );
        return;
    }

    if (!product) {
        customName.required = false;
        customPrice.required = false;
        hint.classList.add('hidden');
        quantityInput.removeAttribute('max');
        document.getElementById('saleTotal').textContent = formatCurrency(0);
        return;
    }
    document.getElementById('saleTotal').textContent = formatCurrency(product.price * quantity);
    if (product.kind === 'produto' && product.stock !== null) {
        quantityInput.max = String(product.stock);
        hint.textContent = `Disponível em estoque: ${product.stock} unidade(s).`;
    } else {
        quantityInput.removeAttribute('max');
        hint.textContent = product.kind === 'servico' ? 'Este serviço não controla estoque.' : 'Estoque sem limite definido.';
    }
    hint.classList.remove('hidden');
}

function formatSaleStatus(status) {
    return { pendente: 'Em aberto', paga: 'Paga', cancelada: 'Cancelada' }[status] || status;
}

function renderSales() {
    const list = document.getElementById('salesList');
    const filter = document.getElementById('salesFilter').value;
    const filtered = sales.filter((sale) => filter === 'todas' || sale.status === filter);
    const paid = sales.filter((sale) => sale.status === 'paga');
    const pending = sales.filter((sale) => sale.status === 'pendente');
    const sum = (items) => items.reduce((total, sale) => total + sale.total, 0);
    document.getElementById('salesRevenue').textContent = formatCurrency(sum(paid));
    document.getElementById('salesPending').textContent = formatCurrency(sum(pending));
    document.getElementById('salesPendingCount').textContent = `${pending.length} venda(s) em aberto`;
    document.getElementById('salesCount').textContent = String(sales.length);
    list.replaceChildren();

    if (!filtered.length) {
        showListMessage('salesList', sales.length ? 'Nenhuma venda para este filtro.' : 'Ainda não há vendas registradas.');
        return;
    }
    filtered.forEach((sale) => {
        const card = makeElement('article', 'sale-card');
        const main = makeElement('div', 'sale-card-main');
        const identity = makeElement('div');
        identity.appendChild(makeElement('strong', 'sale-name', sale.product_name));
        const meta = makeElement('div', 'sale-card-meta');
        meta.append(
            makeElement('span', 'sale-meta', `Venda #${sale.id}`),
            makeElement('span', 'sale-meta', `${sale.quantity} × ${formatCurrency(sale.unit_price)}`),
            makeElement('span', 'sale-meta', sale.customer_name),
            makeElement('span', 'sale-meta', sale.date.split('-').reverse().join('/'))
        );
        identity.appendChild(meta);
        main.append(identity, makeElement('strong', 'sale-card-total', formatCurrency(sale.total)));
        const statusRow = makeElement('div', 'sale-card-meta');
        statusRow.appendChild(makeElement('span', `sale-status status-${sale.status}`, formatSaleStatus(sale.status)));
        card.append(main, statusRow);

        const actions = makeElement('div', 'sale-actions');
        if (sale.status === 'pendente') {
            actions.append(
                buildActionButton('Marcar como paga', 'pay-sale', sale.id),
                buildActionButton('Cancelar venda', 'cancel-sale', sale.id, 'icon-button danger')
            );
            if (sale.demo_payment_url) {
                const demoLink = document.createElement('a');
                demoLink.className = 'icon-button payment-action';
                demoLink.href = sale.demo_payment_url;
                demoLink.target = '_blank';
                demoLink.rel = 'noopener noreferrer';
                demoLink.textContent = 'Abrir link de pagamento';
                actions.appendChild(demoLink);
                actions.appendChild(buildActionButton('Copiar link de pagamento', 'copy-demo-payment', sale.id));
            } else {
                actions.appendChild(buildActionButton('Gerar Link de Pagamento', 'create-demo-payment', sale.id, 'icon-button payment-action'));
            }
        }
        if (actions.childElementCount) card.appendChild(actions);
        list.appendChild(card);
    });
}

async function saveSale(event) {
    event.preventDefault();
    const product = getSelectedProduct();
    const isCustomSale = document.getElementById('saleProduct').value === 'avulsa';
    if (!product && !isCustomSale) {
        showFormMessage('saleMessage', 'Escolha um item do catálogo ou selecione venda avulsa.', true);
        return;
    }
    const payload = {
        email: getCurrentUserEmail(),
        product_id: product ? product.id : null,
        quantity: Number(document.getElementById('saleQuantity').value),
        customer_name: document.getElementById('saleCustomer').value.trim(),
        date: document.getElementById('saleDate').value,
        status: document.getElementById('saleInitialStatus').value,
        item_name: isCustomSale ? document.getElementById('saleItemName').value.trim() : null,
        item_kind: isCustomSale ? document.getElementById('saleItemKind').value : null,
        unit_price: isCustomSale ? Number(document.getElementById('saleUnitPrice').value) : null
    };
    try {
        await requestTransactions('/api/sales', { method: 'POST', body: JSON.stringify(payload) });
        document.getElementById('saleForm').reset();
        document.getElementById('saleQuantity').value = '1';
        document.getElementById('saleDate').value = getTodayDate();
        updateSalePreview();
        await loadApplicationData();
        showFormMessage('saleMessage', 'Venda registrada com sucesso.');
    } catch (error) {
        showFormMessage('saleMessage', `Erro ao registrar venda: ${error.message}`, true);
    }
}

async function updateSaleStatus(sale, status) {
    if (status === 'cancelada' && !window.confirm(`Deseja cancelar a venda #${sale.id}?`)) return;
    try {
        await requestTransactions(`/api/sales/${sale.id}/status`, {
            method: 'PUT',
            body: JSON.stringify({
                email: getCurrentUserEmail(),
                status,
                date: getTodayDate()
            })
        });
        await loadApplicationData();
    } catch (error) {
        showFormMessage('saleMessage', `Erro ao atualizar venda: ${error.message}`, true);
    }
}

async function createDemoPaymentLink(sale) {
    try {
        const result = await requestTransactions(`/api/sales/${sale.id}/demo-payment-link`, {
            method: 'POST',
            body: JSON.stringify({ email: getCurrentUserEmail() })
        });
        await loadSales();
        showFormMessage('saleMessage', result.message);
    } catch (error) {
        showFormMessage('saleMessage', `Erro ao gerar link fictício: ${error.message}`, true);
    }
}

async function copyDemoPaymentLink(url) {
    try {
        await navigator.clipboard.writeText(url);
        showFormMessage('saleMessage', 'Link de pagamento copiado.');
    } catch (error) {
        showFormMessage('saleMessage', 'Não foi possível copiar o link. Use “Abrir link de pagamento” para acessá-lo.', true);
    }
}

async function loadTeamMembers() {
    try {
        const payload = await requestTransactions(getApiUrl('/api/team'));
        teamMembers = payload.members;
        renderTeamMembers();
    } catch (error) {
        teamMembers = [];
        renderTeamMembers();
        showListMessage('teamList', `Erro ao carregar equipe: ${error.message}`, true);
    }
}

function renderTeamMembers() {
    const list = document.getElementById('teamList');
    document.getElementById('teamCount').textContent = String(teamMembers.length);
    list.replaceChildren();
    if (!teamMembers.length) {
        showListMessage('teamList', 'Nenhum integrante cadastrado. Adicione os contatos da sua equipe.');
        return;
    }
    teamMembers.forEach((member) => {
        const card = makeElement('article', 'team-card');
        const identity = makeElement('div', 'team-card-identity');
        const initials = member.name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('');
        identity.appendChild(makeElement('span', 'team-avatar', initials));
        const details = makeElement('div', 'team-card-details');
        details.append(
            makeElement('strong', 'team-name', member.name),
            makeElement('span', 'team-meta', member.role),
            makeElement('span', 'team-meta', member.email),
            makeElement('span', 'team-meta', member.phone || 'Telefone não informado')
        );
        identity.appendChild(details);
        const actions = makeElement('div', 'item-actions');
        actions.append(
            makeElement('span', `member-status status-${member.status}`, member.status === 'ativo' ? 'Ativo' : 'Inativo'),
            buildActionButton('Editar', 'edit-team', member.id),
            buildActionButton('Excluir', 'delete-team', member.id, 'icon-button danger')
        );
        card.append(identity, actions);
        list.appendChild(card);
    });
}

function resetTeamForm() {
    document.getElementById('teamForm').reset();
    document.getElementById('teamMemberId').value = '';
    document.getElementById('teamFormTitle').textContent = 'Adicionar integrante';
    document.getElementById('cancelTeamEdit').classList.add('hidden');
    showFormMessage('teamMessage', '');
}

function editTeamMember(memberId) {
    const member = teamMembers.find((item) => item.id === memberId);
    if (!member) return;
    document.getElementById('teamMemberId').value = String(member.id);
    document.getElementById('teamName').value = member.name;
    document.getElementById('teamRole').value = member.role;
    document.getElementById('teamEmail').value = member.email;
    document.getElementById('teamPhone').value = member.phone;
    document.getElementById('teamStatus').value = member.status;
    document.getElementById('teamFormTitle').textContent = 'Editar integrante';
    document.getElementById('cancelTeamEdit').classList.remove('hidden');
    document.getElementById('teamForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function saveTeamMember(event) {
    event.preventDefault();
    const memberId = document.getElementById('teamMemberId').value;
    const payload = {
        email: getCurrentUserEmail(),
        name: document.getElementById('teamName').value.trim(),
        role: document.getElementById('teamRole').value.trim(),
        member_email: document.getElementById('teamEmail').value.trim(),
        phone: document.getElementById('teamPhone').value.trim(),
        status: document.getElementById('teamStatus').value
    };
    try {
        await requestTransactions(memberId ? `/api/team/${memberId}` : '/api/team', {
            method: memberId ? 'PUT' : 'POST',
            body: JSON.stringify(payload)
        });
        resetTeamForm();
        await loadTeamMembers();
        showFormMessage('teamMessage', 'Integrante salvo com sucesso.');
    } catch (error) {
        showFormMessage('teamMessage', `Erro ao salvar integrante: ${error.message}`, true);
    }
}

async function deleteTeamMember(memberId) {
    if (!window.confirm('Deseja remover este integrante da equipe?')) return;
    try {
        await requestTransactions(`/api/team/${memberId}?email=${encodeURIComponent(getCurrentUserEmail())}`, {
            method: 'DELETE'
        });
        await loadTeamMembers();
        showFormMessage('teamMessage', 'Integrante removido.');
    } catch (error) {
        showFormMessage('teamMessage', `Erro ao remover integrante: ${error.message}`, true);
    }
}

function renderOverview() {
    const confirmedIncome = transactions
        .filter((item) => item.status === 'confirmada' && item.type === 'entrada')
        .reduce((total, item) => total + item.amount, 0);
    const confirmedExpenses = transactions
        .filter((item) => item.status === 'confirmada' && item.type === 'saida')
        .reduce((total, item) => total + item.amount, 0);
    const pendingSales = sales.filter((sale) => sale.status === 'pendente');
    document.getElementById('overviewRevenue').textContent = formatCurrency(
        sales.filter((sale) => sale.status === 'paga').reduce((total, sale) => total + sale.total, 0)
    );
    document.getElementById('overviewPending').textContent = formatCurrency(
        pendingSales.reduce((total, sale) => total + sale.total, 0)
    );
    document.getElementById('overviewPendingCount').textContent = `${pendingSales.length} venda(s) pendente(s)`;
    document.getElementById('overviewProducts').textContent = String(products.length);
    document.getElementById('overviewBalance').textContent = formatCurrency(confirmedIncome - confirmedExpenses);
    renderSalesChart();
    renderRecentSales();
}

function getRecentMonths() {
    const now = new Date();
    return Array.from({ length: 6 }, (_, index) => {
        const date = new Date(now.getFullYear(), now.getMonth() - 5 + index, 1);
        return {
            year: date.getFullYear(),
            month: date.getMonth(),
            label: date.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '')
        };
    });
}

function renderSalesChart() {
    const chart = document.getElementById('salesChart');
    const monthsForChart = getRecentMonths();
    const values = monthsForChart.map(({ year, month }) => sales
        .filter((sale) => {
            const date = new Date(`${sale.date}T00:00:00`);
            return sale.status === 'paga' && date.getFullYear() === year && date.getMonth() === month;
        })
        .reduce((total, sale) => total + sale.total, 0));
    const max = Math.max(...values, 0);
    chart.replaceChildren();
    monthsForChart.forEach((month, index) => {
        const column = makeElement('div', 'chart-column');
        column.setAttribute('aria-label', `${month.label}: ${formatCurrency(values[index])}`);
        column.appendChild(makeElement('span', 'chart-value', values[index] ? formatCurrency(values[index]) : '—'));
        const track = makeElement('div', 'chart-track');
        const bar = makeElement('div', 'chart-bar');
        bar.style.height = `${max ? Math.max(4, values[index] / max * 100) : 0}%`;
        track.appendChild(bar);
        column.append(track, makeElement('span', 'chart-month', month.label));
        chart.appendChild(column);
    });
}

function renderRecentSales() {
    const list = document.getElementById('recentSales');
    list.replaceChildren();
    if (!sales.length) {
        showListMessage('recentSales', 'As vendas registradas aparecerão aqui.');
        return;
    }
    sales.slice(0, 4).forEach((sale) => {
        const item = makeElement('div', 'recent-sale');
        const details = makeElement('div');
        details.append(
            makeElement('strong', 'recent-sale-name', sale.product_name),
            makeElement('span', 'recent-sale-meta', `${sale.date.split('-').reverse().join('/')} · ${formatSaleStatus(sale.status)}`)
        );
        item.append(details, makeElement('strong', 'recent-sale-amount', formatCurrency(sale.total)));
        list.appendChild(item);
    });
}

function startHomeSalesRefresh() {
    if (homeSalesRefreshTimer) return;
    homeSalesRefreshTimer = window.setInterval(() => {
        if (getCurrentUserEmail()) loadSales();
    }, 60_000);
}

function stopHomeSalesRefresh() {
    if (!homeSalesRefreshTimer) return;
    window.clearInterval(homeSalesRefreshTimer);
    homeSalesRefreshTimer = null;
}

function initManagementControls() {
    document.querySelectorAll('.view-tab').forEach((tab) => {
        tab.addEventListener('click', () => showView(tab.dataset.view));
    });
    document.querySelectorAll('[data-go-to]').forEach((button) => {
        button.addEventListener('click', () => showView(button.dataset.goTo));
    });

    document.getElementById('productForm').addEventListener('submit', saveProduct);
    document.getElementById('productKind').addEventListener('change', updateProductStockField);
    document.getElementById('productSearch').addEventListener('input', renderProducts);
    document.getElementById('cancelProductEdit').addEventListener('click', resetProductForm);
    document.getElementById('productList').addEventListener('click', (event) => {
        const button = event.target.closest('button[data-action]');
        if (!button) return;
        const id = Number(button.dataset.id);
        if (button.dataset.action === 'edit-product') editProduct(id);
        if (button.dataset.action === 'delete-product') deleteProduct(id);
    });

    document.getElementById('saleForm').addEventListener('submit', saveSale);
    document.getElementById('saleProduct').addEventListener('change', updateSalePreview);
    document.getElementById('saleQuantity').addEventListener('input', updateSalePreview);
    document.getElementById('saleUnitPrice').addEventListener('input', updateSalePreview);
    document.getElementById('salesFilter').addEventListener('change', renderSales);
    document.getElementById('salesList').addEventListener('click', (event) => {
        const button = event.target.closest('button[data-action]');
        if (!button) return;
        const sale = sales.find((item) => item.id === Number(button.dataset.id));
        if (!sale) return;
        if (button.dataset.action === 'pay-sale') updateSaleStatus(sale, 'paga');
        if (button.dataset.action === 'cancel-sale') updateSaleStatus(sale, 'cancelada');
        if (button.dataset.action === 'create-demo-payment') createDemoPaymentLink(sale);
        if (button.dataset.action === 'copy-demo-payment') {
            copyDemoPaymentLink(new URL(sale.demo_payment_url, window.location.origin).href);
        }
    });

    document.getElementById('teamForm').addEventListener('submit', saveTeamMember);
    document.getElementById('cancelTeamEdit').addEventListener('click', resetTeamForm);
    document.getElementById('teamList').addEventListener('click', (event) => {
        const button = event.target.closest('button[data-action]');
        if (!button) return;
        const id = Number(button.dataset.id);
        if (button.dataset.action === 'edit-team') editTeamMember(id);
        if (button.dataset.action === 'delete-team') deleteTeamMember(id);
    });

    document.getElementById('saleDate').value = getTodayDate();
    updateProductStockField();
}

function getTodayDate() {
    const now = new Date();
    const localDate = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
    return localDate.toISOString().slice(0, 10);
}

function initApp() {
    populateFilters();
    populateYearFilter();
    renderTransactionTable();
    initCostControls();
    initCalculatorControls();
    renderCostTable();

    const monthFilter = document.getElementById('monthFilter');
    const yearFilter = document.getElementById('yearFilter');
    const typeFilter = document.getElementById('typeFilter');
    const transactionForm = document.getElementById('transactionForm');
    const excelBtn = document.getElementById('excelBtn');
    const pdfBtn = document.getElementById('pdfBtn');
    const saveProfileBtn = document.getElementById('saveProfileBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    const updateProfileBtn = document.getElementById('updateProfileBtn');
    const cancelProfileBtn = document.getElementById('cancelProfileBtn');
    const loginForm = document.getElementById('loginForm');
    const registerForm = document.getElementById('registerForm');

    document.getElementById('transactionDate').value = getTodayDate();
    if (monthFilter) monthFilter.addEventListener('change', renderTransactionTable);
    if (yearFilter) yearFilter.addEventListener('change', renderTransactionTable);
    if (typeFilter) typeFilter.addEventListener('change', renderTransactionTable);
    if (transactionForm) transactionForm.addEventListener('submit', addTransaction);
    if (excelBtn) excelBtn.addEventListener('click', exportExcel);
    if (pdfBtn) pdfBtn.addEventListener('click', exportPdf);
    if (saveProfileBtn) saveProfileBtn.addEventListener('click', handleUpdateProfile);
    if (logoutBtn) logoutBtn.addEventListener('click', handleLogout);
    if (updateProfileBtn) updateProfileBtn.addEventListener('click', showProfileView);
    if (cancelProfileBtn) cancelProfileBtn.addEventListener('click', showDashboardView);
    if (loginForm) loginForm.addEventListener('submit', handleLogin);
    if (registerForm) registerForm.addEventListener('submit', handleRegister);

    initAuthTabs();
    initManagementControls();

    restoreSessionUser();
}

document.addEventListener('DOMContentLoaded', initApp);
