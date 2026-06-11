function calculate() {
    // Pegar valores
    const mat = parseFloat(document.getElementById('mat').value) || 0;
    const labor = parseFloat(document.getElementById('labor').value) || 0;
    const markup = parseFloat(document.getElementById('markup').value) || 0;
    const tax = parseFloat(document.getElementById('tax').value) || 0;

    // Cálculo de Custo Total
    const totalCost = mat + labor;

    // Fórmula: Preço = Custo / (1 - (Markup% + Taxa%)/100)
    const divisor = 1 - ((markup + tax) / 100);
    
    let finalPrice = 0;
    if (divisor > 0) {
        finalPrice = totalCost / divisor;
    } else {
        alert("A soma das margens não pode ultrapassar 100%");
        return;
    }

    const profit = finalPrice * (markup / 100);

    // Atualizar UI com animação simples
    animateValue("final-price", finalPrice);
    document.getElementById('total-cost-view').innerText = `R$ ${totalCost.toLocaleString('pt-BR', {minimumFractionDigits: 2})}`;
    document.getElementById('profit-view').innerText = `R$ ${profit.toLocaleString('pt-BR', {minimumFractionDigits: 2})}`;
}

function animateValue(id, value) {
    const obj = document.getElementById(id);
    obj.innerText = value.toLocaleString('pt-BR', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}