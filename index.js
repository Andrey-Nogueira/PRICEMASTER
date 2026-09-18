const STORAGE_USERS = 'infinity_users';
const STORAGE_SESSION = 'infinity_session';

const receiptData = [
    { month: 'Janeiro', year: 2025, value: 14500 },
    { month: 'Fevereiro', year: 2025, value: 15320 },
    { month: 'Março', year: 2025, value: 14880 },
    { month: 'Abril', year: 2025, value: 16240 },
    { month: 'Maio', year: 2025, value: 17010 },
    { month: 'Junho', year: 2025, value: 15890 },
    { month: 'Julho', year: 2025, value: 17340 },
    { month: 'Agosto', year: 2025, value: 18120 },
    { month: 'Setembro', year: 2025, value: 16650 },
    { month: 'Outubro', year: 2025, value: 17600 },
    { month: 'Novembro', year: 2025, value: 18840 },
    { month: 'Dezembro', year: 2025, value: 20130 },
    { month: 'Janeiro', year: 2026, value: 16750 },
    { month: 'Fevereiro', year: 2026, value: 17140 },
    { month: 'Março', year: 2026, value: 17980 },
    { month: 'Abril', year: 2026, value: 18625 }
];

const months = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

let registeredCosts = [];

function calculate() {
    const mat = parseFloat(document.getElementById('mat').value) || 0;
    const labor = parseFloat(document.getElementById('labor').value) || 0;
    const markup = parseFloat(document.getElementById('markup').value) || 0;
    const tax = parseFloat(document.getElementById('tax').value) || 0;

    const totalCost = getCurrentTotalCost();
    const divisor = 1 - ((markup + tax) / 100);

    let finalPrice = 0;
    if (divisor > 0) {
        finalPrice = totalCost / divisor;
    } else {
        alert('A soma das margens não pode ultrapassar 100%');
        return;
    }

    const profit = finalPrice * (markup / 100);

    animateValue('final-price', finalPrice);
    document.getElementById('total-cost-view').innerText = `R$ ${totalCost.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
    document.getElementById('profit-view').innerText = `R$ ${profit.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
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
    localStorage.setItem(STORAGE_USERS, JSON.stringify(users));
}

function getSessionUser() {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_SESSION));
    } catch (error) {
        return null;
    }
}

function setSessionUser(user) {
    localStorage.setItem(STORAGE_SESSION, JSON.stringify(user));
}

function clearSessionUser() {
    localStorage.removeItem(STORAGE_SESSION);
}

function showAuthView() {
    const authView = document.getElementById('authView');
    const appView = document.getElementById('appView');

    authView.classList.remove('hidden');
    appView.classList.add('hidden');
}

function showDashboardView() {
    const dashboardView = document.getElementById('dashboardView');
    const profileView = document.getElementById('profileView');

    if (dashboardView) dashboardView.classList.remove('hidden');
    if (profileView) profileView.classList.add('hidden');
}

function showProfileView() {
    const dashboardView = document.getElementById('dashboardView');
    const profileView = document.getElementById('profileView');

    if (dashboardView) dashboardView.classList.add('hidden');
    if (profileView) profileView.classList.remove('hidden');
}

function showAppView() {
    const authView = document.getElementById('authView');
    const appView = document.getElementById('appView');

    authView.classList.add('hidden');
    appView.classList.remove('hidden');
    showDashboardView();
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

function handleLogin(event) {
    event.preventDefault();

    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value.trim();

    if (!email || !password) {
        alert('Preencha e-mail e senha para continuar.');
        return;
    }

    const sessionUser = {
        name: email.includes('@') ? email.split('@')[0].replace(/[._-]/g, ' ') : email,
        document: 'Não informado',
        email: email.toLowerCase(),
        password,
        phone: '',
        address: ''
    };

    setSessionUser(sessionUser);
    showAppView();
    renderProfileForm();
    document.getElementById('loginForm').reset();
}

function handleRegister(event) {
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

    const users = getUsers();
    const alreadyExists = users.some((user) => user.email.toLowerCase() === email);

    if (alreadyExists) {
        alert('Este e-mail já está cadastrado.');
        return;
    }

    const newUser = {
        name,
        document: documentValue,
        email,
        password,
        phone: '',
        address: ''
    };

    users.push(newUser);
    setUsers(users);
    setSessionUser(newUser);
    document.getElementById('registerForm').reset();
    showAppView();
    renderProfileForm();
    alert('Cadastro realizado com sucesso!');
}

function handleUpdateProfile() {
    const currentUser = getSessionUser();
    if (!currentUser) {
        alert('Faça login para atualizar o cadastro.');
        return;
    }

    const updatedUser = {
        ...currentUser,
        name: document.getElementById('profileName').value.trim(),
        document: document.getElementById('profileDocument').value.trim(),
        email: document.getElementById('profileEmail').value.trim().toLowerCase(),
        phone: document.getElementById('profilePhone').value.trim(),
        address: document.getElementById('profileAddress').value.trim()
    };

    if (!updatedUser.name || !updatedUser.document || !updatedUser.email) {
        alert('Nome, documento e e-mail são obrigatórios.');
        return;
    }

    const users = getUsers();
    const userIndex = users.findIndex((user) => user.email.toLowerCase() === currentUser.email.toLowerCase());

    if (userIndex >= 0) {
        users[userIndex] = updatedUser;
        setUsers(users);
        setSessionUser(updatedUser);
        renderProfileForm();
        showDashboardView();
        alert('Cadastro atualizado com sucesso!');
    } else {
        alert('Usuário não encontrado no cadastro.');
    }
}

function handleLogout() {
    clearSessionUser();
    showAuthView();
    document.getElementById('loginForm').reset();
    document.getElementById('registerForm').reset();
}

function populateFilters() {
    const monthFilter = document.getElementById('monthFilter');
    const yearFilter = document.getElementById('yearFilter');

    months.forEach((month) => {
        const option = document.createElement('option');
        option.value = month;
        option.textContent = month;
        monthFilter.appendChild(option);
    });

    const uniqueYears = [...new Set(receiptData.map((item) => item.year))].sort((a, b) => a - b);
    uniqueYears.forEach((year) => {
        const option = document.createElement('option');
        option.value = year;
        option.textContent = year;
        yearFilter.appendChild(option);
    });

    monthFilter.value = 'todos';
    yearFilter.value = String(uniqueYears[uniqueYears.length - 1]);
}

function getFilteredReceipts() {
    const monthFilter = document.getElementById('monthFilter');
    const yearFilter = document.getElementById('yearFilter');
    const selectedMonth = monthFilter.value;
    const selectedYear = Number(yearFilter.value);

    return receiptData.filter((item) => {
        const matchesMonth = selectedMonth === 'todos' || item.month === selectedMonth;
        const matchesYear = Number(item.year) === selectedYear;
        return matchesMonth && matchesYear;
    });
}

function renderReceiptTable() {
    const rows = getFilteredReceipts();
    const body = document.getElementById('receiptTableBody');
    const totalReceitas = document.getElementById('totalReceitas');
    const qtdReceitas = document.getElementById('qtdReceitas');

    body.innerHTML = '';

    rows.forEach((item) => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${item.month}</td>
            <td>${item.year}</td>
            <td>R$ ${item.value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        `;
        body.appendChild(row);
    });

    const total = rows.reduce((sum, item) => sum + item.value, 0);
    totalReceitas.innerText = `R$ ${total.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    qtdReceitas.innerText = `${rows.length} ${rows.length === 1 ? 'registro' : 'registros'}`;

    if (!rows.length) {
        body.innerHTML = '<tr><td colspan="3" class="empty-state">Nenhum recebimento encontrado para esse filtro.</td></tr>';
        totalReceitas.innerText = 'R$ 0,00';
        qtdReceitas.innerText = '0 registros';
    }
}

function exportExcel() {
    const rows = getFilteredReceipts();
    const header = ['Mês', 'Ano', 'Recebimento'];
    const csvRows = [header.join(',')];

    rows.forEach((item) => {
        csvRows.push([item.month, item.year, item.value].join(','));
    });

    const csvContent = csvRows.join('\n');
    const blob = new Blob([csvContent], { type: 'application/vnd.ms-excel;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = url;
    link.download = `recebimentos_${document.getElementById('yearFilter').value}.csv`;
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
}

function removeCostItem(id) {
    registeredCosts = registeredCosts.filter((item) => item.id !== id);
    renderCostTable();
    calculate();
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
        row.innerHTML = `
            <td>${item.name}</td>
            <td>${item.type}</td>
            <td>R$ ${item.value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
            <td><button class="remove-cost-btn" type="button" data-id="${item.id}">Excluir</button></td>
        `;
        body.appendChild(row);
    });

    document.querySelectorAll('.remove-cost-btn').forEach((button) => {
        button.addEventListener('click', () => removeCostItem(Number(button.dataset.id)));
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
        });
    }
}

function initApp() {
    populateFilters();
    renderReceiptTable();
    initCostControls();
    renderCostTable();

    const monthFilter = document.getElementById('monthFilter');
    const yearFilter = document.getElementById('yearFilter');
    const excelBtn = document.getElementById('excelBtn');
    const pdfBtn = document.getElementById('pdfBtn');
    const saveProfileBtn = document.getElementById('saveProfileBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    const updateProfileBtn = document.getElementById('updateProfileBtn');
    const cancelProfileBtn = document.getElementById('cancelProfileBtn');
    const loginForm = document.getElementById('loginForm');
    const registerForm = document.getElementById('registerForm');

    if (monthFilter) monthFilter.addEventListener('change', renderReceiptTable);
    if (yearFilter) yearFilter.addEventListener('change', renderReceiptTable);
    if (excelBtn) excelBtn.addEventListener('click', exportExcel);
    if (pdfBtn) pdfBtn.addEventListener('click', exportPdf);
    if (saveProfileBtn) saveProfileBtn.addEventListener('click', handleUpdateProfile);
    if (logoutBtn) logoutBtn.addEventListener('click', handleLogout);
    if (updateProfileBtn) updateProfileBtn.addEventListener('click', showProfileView);
    if (cancelProfileBtn) cancelProfileBtn.addEventListener('click', showDashboardView);
    if (loginForm) loginForm.addEventListener('submit', handleLogin);
    if (registerForm) registerForm.addEventListener('submit', handleRegister);

    initAuthTabs();

    if (getSessionUser()) {
        showAppView();
        renderProfileForm();
    } else {
        showAuthView();
    }
}

document.addEventListener('DOMContentLoaded', initApp);
