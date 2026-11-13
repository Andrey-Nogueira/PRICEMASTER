import json
import hashlib
import hmac
import html
import mimetypes
import os
import re
import sqlite3
import urllib.error
import urllib.request
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from uuid import uuid4
from urllib.parse import parse_qs, unquote, urlparse


ROOT = Path(__file__).resolve().parent
DATABASE = ROOT / "data" / "infinity_price.db"
HOST = "127.0.0.1"
PORT = 5173
TRANSACTION_TYPES = {"entrada", "saida"}
TRANSACTION_STATUSES = {"confirmada", "pendente"}
MAX_AMOUNT = Decimal("999999999.99")
MAX_TEXT_LENGTH = 200
PASSWORD_HASH_ITERATIONS = 310_000
CALCULATION_COST_TYPES = {"Materia-prima", "Mao de obra", "Servico", "Transporte", "Despesa"}


def initialize_database():
    DATABASE.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DATABASE) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_email TEXT NOT NULL,
                type TEXT NOT NULL CHECK (type IN ('entrada', 'saida')),
                description TEXT NOT NULL,
                category TEXT NOT NULL,
                amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
                transaction_date TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('confirmada', 'pendente')),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_transactions_owner_date "
            "ON transactions (owner_email, transaction_date DESC, id DESC)"
        )
        transaction_columns = {
            row[1] for row in connection.execute("PRAGMA table_info(transactions)")
        }
        for column, definition in (
            ("source_type", "TEXT NOT NULL DEFAULT 'manual'"),
            ("source_id", "INTEGER"),
        ):
            if column not in transaction_columns:
                connection.execute(f"ALTER TABLE transactions ADD COLUMN {column} {definition}")
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS accounts (
                email TEXT PRIMARY KEY,
                password_hash TEXT NOT NULL,
                name TEXT NOT NULL,
                document TEXT NOT NULL,
                phone TEXT NOT NULL DEFAULT '',
                address TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS pricing_calculations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_email TEXT NOT NULL,
                legacy_id TEXT,
                name TEXT NOT NULL,
                hourly_rate_cents INTEGER CHECK (hourly_rate_cents IS NULL OR hourly_rate_cents >= 0),
                material_cents INTEGER NOT NULL CHECK (material_cents >= 0),
                labor_cents INTEGER NOT NULL CHECK (labor_cents >= 0),
                markup_basis_points INTEGER NOT NULL CHECK (markup_basis_points BETWEEN 0 AND 10000),
                tax_basis_points INTEGER NOT NULL CHECK (tax_basis_points BETWEEN 0 AND 10000),
                business_model TEXT NOT NULL CHECK (business_model IN ('produto', 'servico')),
                costs_json TEXT NOT NULL,
                final_price_cents INTEGER NOT NULL CHECK (final_price_cents >= 0),
                total_cost_cents INTEGER NOT NULL CHECK (total_cost_cents >= 0),
                labor_cost_cents INTEGER NOT NULL CHECK (labor_cost_cents >= 0),
                direct_costs_cents INTEGER NOT NULL CHECK (direct_costs_cents >= 0),
                tax_cents INTEGER NOT NULL CHECK (tax_cents >= 0),
                profit_cents INTEGER NOT NULL CHECK (profit_cents >= 0),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (owner_email, legacy_id)
            );
            CREATE INDEX IF NOT EXISTS idx_calculations_owner_date
                ON pricing_calculations (owner_email, updated_at DESC, id DESC);
            CREATE TABLE IF NOT EXISTS pricing_drafts (
                owner_email TEXT PRIMARY KEY,
                draft_json TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS products (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_email TEXT NOT NULL,
                kind TEXT NOT NULL CHECK (kind IN ('produto', 'servico')),
                name TEXT NOT NULL,
                category TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                price_cents INTEGER NOT NULL CHECK (price_cents > 0),
                stock_quantity INTEGER CHECK (stock_quantity IS NULL OR stock_quantity >= 0),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_products_owner_name
                ON products (owner_email, name);
            CREATE TABLE IF NOT EXISTS sales (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_email TEXT NOT NULL,
                product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
                product_name TEXT NOT NULL,
                product_kind TEXT NOT NULL CHECK (product_kind IN ('produto', 'servico')),
                quantity INTEGER NOT NULL CHECK (quantity > 0),
                unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents > 0),
                total_cents INTEGER NOT NULL CHECK (total_cents > 0),
                customer_name TEXT NOT NULL,
                sale_date TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('pendente', 'paga', 'cancelada')),
                payment_preference_id TEXT,
                payment_url TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_sales_owner_date
                ON sales (owner_email, sale_date DESC, id DESC);
            CREATE TABLE IF NOT EXISTS team_members (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_email TEXT NOT NULL,
                name TEXT NOT NULL,
                role TEXT NOT NULL,
                email TEXT NOT NULL,
                phone TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL CHECK (status IN ('ativo', 'inativo')),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (owner_email, email)
            );
            CREATE INDEX IF NOT EXISTS idx_team_owner_name
                ON team_members (owner_email, name);
            """
        )
        sale_columns = {
            row[1] for row in connection.execute("PRAGMA table_info(sales)")
        }
        if "demo_payment_token" not in sale_columns:
            connection.execute("ALTER TABLE sales ADD COLUMN demo_payment_token TEXT")
        connection.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_demo_payment_token "
            "ON sales (demo_payment_token) WHERE demo_payment_token IS NOT NULL"
        )


class ApplicationHandler(BaseHTTPRequestHandler):
    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def get_owner_email(self, values):
        email = values.get("email", [""])[0].strip().lower()
        if not email or len(email) > 254 or not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
            raise ValueError("Faça login com um e-mail válido para acessar as movimentações.")
        return email

    def hash_password(self, password):
        salt = os.urandom(16)
        digest = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), salt, PASSWORD_HASH_ITERATIONS
        )
        return f"{salt.hex()}:{digest.hex()}"

    def verify_password(self, password, stored_hash):
        try:
            salt_hex, digest_hex = stored_hash.split(":", 1)
            salt = bytes.fromhex(salt_hex)
            expected_digest = bytes.fromhex(digest_hex)
        except (AttributeError, ValueError):
            return False
        actual_digest = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), salt, PASSWORD_HASH_ITERATIONS
        )
        return hmac.compare_digest(actual_digest, expected_digest)

    def account_email(self, value):
        if not isinstance(value, str):
            raise ValueError("Informe um e-mail válido.")
        try:
            return self.get_owner_email({"email": [value]})
        except ValueError:
            raise ValueError("Informe um e-mail válido.") from None

    def account_values(self, payload):
        email = self.account_email(payload.get("email"))
        name = self.validate_text(payload.get("name"), "o nome", 200)
        document = self.validate_text(payload.get("document"), "o CPF ou CNPJ", 30)
        phone = self.validate_text(payload.get("phone", ""), "o telefone", 40, required=False)
        address = self.validate_text(payload.get("address", ""), "o endereço", 300, required=False)
        password = payload.get("password")
        if not isinstance(password, str) or not password or len(password) > 128:
            raise ValueError("A senha deve ter entre 1 e 128 caracteres.")
        return email, name, document, phone, address, password

    def public_account(self, row):
        return {
            "email": row["email"],
            "name": row["name"],
            "document": row["document"],
            "phone": row["phone"],
            "address": row["address"],
        }

    def non_negative_amount_cents(self, amount, label):
        if not isinstance(amount, (int, float, str)) or isinstance(amount, bool):
            raise ValueError(f"Informe um valor válido para {label}.")
        try:
            decimal_amount = Decimal(str(amount))
        except InvalidOperation:
            raise ValueError(f"Informe um valor válido para {label}.") from None
        if not decimal_amount.is_finite() or decimal_amount < 0:
            raise ValueError(f"{label.capitalize()} deve ser igual ou maior que zero.")
        if decimal_amount > MAX_AMOUNT:
            raise ValueError(f"{label.capitalize()} excede o limite permitido.")
        if decimal_amount.as_tuple().exponent < -2:
            raise ValueError(f"Informe no máximo duas casas decimais para {label}.")
        return int((decimal_amount * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))

    def calculation_values(self, payload):
        name = self.validate_text(payload.get("name"), "o nome do cálculo", 120, required=False)
        name = name or "Serviço ou produto"
        inputs = payload.get("inputs")
        if not isinstance(inputs, dict):
            raise ValueError("Os dados do cálculo são inválidos.")

        material_cents = self.non_negative_amount_cents(inputs.get("mat", 0), "matéria-prima")
        base_labor_cents = self.non_negative_amount_cents(inputs.get("labor", 0), "mão de obra")
        hourly_rate = inputs.get("hourlyRate")
        hourly_rate_cents = (
            None if hourly_rate is None or hourly_rate == ""
            else self.non_negative_amount_cents(hourly_rate, "valor da hora")
        )
        percentages = []
        for key, label in (("markup", "margem"), ("tax", "impostos")):
            value = inputs.get(key)
            if not isinstance(value, (int, float, str)) or isinstance(value, bool):
                raise ValueError(f"Informe um percentual válido para {label}.")
            try:
                percentage = Decimal(str(value))
            except InvalidOperation:
                raise ValueError(f"Informe um percentual válido para {label}.") from None
            if not percentage.is_finite() or percentage < 0 or percentage > 100:
                raise ValueError(f"{label.capitalize()} deve estar entre 0% e 100%.")
            if percentage.as_tuple().exponent < -2:
                raise ValueError(f"Informe no máximo duas casas decimais para {label}.")
            percentages.append(int((percentage * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP)))
        markup_basis_points, tax_basis_points = percentages
        if markup_basis_points + tax_basis_points >= 10_000:
            raise ValueError("A soma da margem e dos impostos deve ser menor que 100%.")

        business_model = inputs.get("businessModel")
        if not isinstance(business_model, str) or business_model not in {"produto", "servico"}:
            raise ValueError("Selecione produto ou serviço.")

        costs = inputs.get("costs", [])
        if not isinstance(costs, list) or len(costs) > 200:
            raise ValueError("A lista de custos é inválida.")
        normalized_costs = []
        for cost in costs:
            if not isinstance(cost, dict):
                raise ValueError("Um dos custos cadastrados é inválido.")
            cost_name = self.validate_text(cost.get("name"), "a descrição do custo", 200)
            cost_type = cost.get("type")
            cost_model = cost.get("model")
            if (
                not isinstance(cost_type, str)
                or cost_type not in CALCULATION_COST_TYPES
                or not isinstance(cost_model, str)
                or cost_model not in {"produto", "servico"}
            ):
                raise ValueError("Um dos custos cadastrados possui tipo inválido.")
            amount_cents = self.non_negative_amount_cents(cost.get("value"), "valor do custo")
            if amount_cents == 0:
                raise ValueError("O valor dos custos cadastrados deve ser maior que zero.")
            cost_id = cost.get("id")
            if not isinstance(cost_id, (str, int, float)) or isinstance(cost_id, bool):
                raise ValueError("Um dos custos cadastrados não possui identificador válido.")
            normalized_costs.append(
                {
                    "id": str(cost_id),
                    "name": cost_name,
                    "type": cost_type,
                    "model": cost_model,
                    "value_cents": amount_cents,
                }
            )

        selected_costs = [cost for cost in normalized_costs if cost["model"] == business_model]
        custom_labor_cents = sum(
            cost["value_cents"] for cost in selected_costs if cost["type"] == "Mao de obra"
        )
        custom_direct_cents = sum(
            cost["value_cents"] for cost in selected_costs if cost["type"] != "Mao de obra"
        )
        labor_cost_cents = base_labor_cents + custom_labor_cents
        direct_costs_cents = material_cents + custom_direct_cents
        total_cost_cents = labor_cost_cents + direct_costs_cents
        if total_cost_cents > int(MAX_AMOUNT * 100):
            raise ValueError("O custo total excede o limite permitido.")

        denominator = 10_000 - markup_basis_points - tax_basis_points
        final_price_cents = int(
            (Decimal(total_cost_cents * 10_000) / Decimal(denominator)).quantize(
                Decimal("1"), rounding=ROUND_HALF_UP
            )
        )
        tax_cents = int(
            (Decimal(final_price_cents * tax_basis_points) / Decimal(10_000)).quantize(
                Decimal("1"), rounding=ROUND_HALF_UP
            )
        )
        profit_cents = final_price_cents - total_cost_cents - tax_cents
        return {
            "name": name,
            "hourly_rate_cents": hourly_rate_cents,
            "material_cents": material_cents,
            "labor_cents": base_labor_cents,
            "markup_basis_points": markup_basis_points,
            "tax_basis_points": tax_basis_points,
            "business_model": business_model,
            "costs": normalized_costs,
            "final_price_cents": final_price_cents,
            "total_cost_cents": total_cost_cents,
            "labor_cost_cents": labor_cost_cents,
            "direct_costs_cents": direct_costs_cents,
            "tax_cents": tax_cents,
            "profit_cents": profit_cents,
        }

    def calculation_response(self, row):
        costs = json.loads(row["costs_json"])
        return {
            "id": row["id"],
            "name": row["name"],
            "inputs": {
                "serviceName": row["name"],
                "hourlyRate": (
                    None if row["hourly_rate_cents"] is None
                    else row["hourly_rate_cents"] / 100
                ),
                "mat": row["material_cents"] / 100,
                "labor": row["labor_cents"] / 100,
                "markup": row["markup_basis_points"] / 100,
                "tax": row["tax_basis_points"] / 100,
                "businessModel": row["business_model"],
                "costs": [
                    {
                        "id": cost["id"],
                        "name": cost["name"],
                        "type": cost["type"],
                        "model": cost["model"],
                        "value": cost["value_cents"] / 100,
                    }
                    for cost in costs
                ],
            },
            "finalPriceCents": row["final_price_cents"],
            "totalCostCents": row["total_cost_cents"],
            "breakdown": {
                "laborCents": row["labor_cost_cents"],
                "directCostsCents": row["direct_costs_cents"],
                "taxCents": row["tax_cents"],
                "profitCents": row["profit_cents"],
            },
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }

    def save_calculation(self, connection, owner_email, payload, calculation_id=None, legacy_id=None):
        values = self.calculation_values(payload)
        serialized_costs = json.dumps(values.pop("costs"), ensure_ascii=False, separators=(",", ":"))
        if calculation_id is None:
            cursor = connection.execute(
                """
                INSERT INTO pricing_calculations (
                    owner_email, legacy_id, name, hourly_rate_cents, material_cents, labor_cents,
                    markup_basis_points, tax_basis_points, business_model, costs_json,
                    final_price_cents, total_cost_cents, labor_cost_cents, direct_costs_cents,
                    tax_cents, profit_cents
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    owner_email, legacy_id, values["name"], values["hourly_rate_cents"],
                    values["material_cents"], values["labor_cents"], values["markup_basis_points"],
                    values["tax_basis_points"], values["business_model"], serialized_costs,
                    values["final_price_cents"], values["total_cost_cents"], values["labor_cost_cents"],
                    values["direct_costs_cents"], values["tax_cents"], values["profit_cents"],
                ),
            )
            calculation_id = cursor.lastrowid
        else:
            cursor = connection.execute(
                """
                UPDATE pricing_calculations SET
                    name = ?, hourly_rate_cents = ?, material_cents = ?, labor_cents = ?,
                    markup_basis_points = ?, tax_basis_points = ?, business_model = ?, costs_json = ?,
                    final_price_cents = ?, total_cost_cents = ?, labor_cost_cents = ?,
                    direct_costs_cents = ?, tax_cents = ?, profit_cents = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND owner_email = ?
                """,
                (
                    values["name"], values["hourly_rate_cents"], values["material_cents"],
                    values["labor_cents"], values["markup_basis_points"], values["tax_basis_points"],
                    values["business_model"], serialized_costs, values["final_price_cents"],
                    values["total_cost_cents"], values["labor_cost_cents"],
                    values["direct_costs_cents"], values["tax_cents"], values["profit_cents"],
                    calculation_id, owner_email,
                ),
            )
            if cursor.rowcount == 0:
                return None
        connection.row_factory = sqlite3.Row
        row = connection.execute(
            "SELECT * FROM pricing_calculations WHERE id = ? AND owner_email = ?",
            (calculation_id, owner_email),
        ).fetchone()
        return self.calculation_response(row)

    def read_json_payload(self, maximum_length=16_384):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > maximum_length:
            raise ValueError("Os dados enviados são inválidos.")
        payload = json.loads(self.rfile.read(length))
        if not isinstance(payload, dict):
            raise ValueError("Os dados enviados devem estar em um objeto JSON.")
        return payload

    def validate_text(self, value, label, maximum=MAX_TEXT_LENGTH, required=True):
        if not isinstance(value, str):
            raise ValueError(f"Informe {label}.")
        value = value.strip()
        if required and not value:
            raise ValueError(f"Informe {label}.")
        if len(value) > maximum:
            raise ValueError(f"{label.capitalize()} deve ter no máximo {maximum} caracteres.")
        return value

    def validate_amount_cents(self, amount):
        if not isinstance(amount, (int, float, str)) or isinstance(amount, bool):
            raise ValueError("Informe um valor válido.")
        try:
            decimal_amount = Decimal(str(amount))
        except InvalidOperation:
            raise ValueError("Informe um valor válido.") from None
        if not decimal_amount.is_finite() or decimal_amount < Decimal("0.01"):
            raise ValueError("O valor mínimo é R$ 0,01.")
        if decimal_amount > MAX_AMOUNT:
            raise ValueError("O valor máximo é R$ 999.999.999,99.")
        if decimal_amount.as_tuple().exponent < -2:
            raise ValueError("Informe no máximo duas casas decimais.")
        return int((decimal_amount * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))

    def validate_date(self, value, label="data"):
        if not isinstance(value, str):
            raise ValueError(f"Informe uma {label} válida.")
        try:
            parsed_date = date.fromisoformat(value)
        except ValueError:
            raise ValueError(f"Informe uma {label} válida.") from None
        if parsed_date.isoformat() != value:
            raise ValueError(f"Informe uma {label} válida.")
        return value

    def register_account(self):
        try:
            payload = self.read_json_payload()
            email, name, document, phone, address, password = self.account_values(payload)
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError, AttributeError) as error:
            self.send_json(400, {"error": str(error) or "Os dados da conta são inválidos."})
            return

        try:
            with sqlite3.connect(DATABASE) as connection:
                connection.execute(
                    """
                    INSERT INTO accounts (email, password_hash, name, document, phone, address)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (email, self.hash_password(password), name, document, phone, address),
                )
                connection.row_factory = sqlite3.Row
                account = connection.execute(
                    "SELECT email, name, document, phone, address FROM accounts WHERE email = ?",
                    (email,),
                ).fetchone()
        except sqlite3.IntegrityError:
            self.send_json(409, {"error": "Já existe uma conta cadastrada com este e-mail."})
            return
        except sqlite3.Error:
            self.send_json(500, {"error": "Não foi possível registrar a conta no banco SQLite."})
            return
        self.send_json(201, {"user": self.public_account(account), "message": "Cadastro realizado com sucesso."})

    def login_account(self):
        try:
            payload = self.read_json_payload()
            email = self.account_email(payload.get("email"))
            password = payload.get("password")
            if not isinstance(password, str) or not password or len(password) > 128:
                raise ValueError("Informe uma senha válida.")
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError, AttributeError) as error:
            self.send_json(400, {"error": str(error) or "Os dados de acesso são inválidos."})
            return

        try:
            with sqlite3.connect(DATABASE) as connection:
                connection.row_factory = sqlite3.Row
                account = connection.execute(
                    "SELECT email, password_hash, name, document, phone, address FROM accounts WHERE email = ?",
                    (email,),
                ).fetchone()
        except sqlite3.Error:
            self.send_json(500, {"error": "Não foi possível acessar as contas no banco SQLite."})
            return
        if not account or not self.verify_password(password, account["password_hash"]):
            self.send_json(401, {"error": "E-mail ou senha inválidos."})
            return
        self.send_json(200, {"user": self.public_account(account)})

    def update_account(self):
        try:
            payload = self.read_json_payload()
            old_email = self.account_email(payload.get("currentEmail"))
            email = self.account_email(payload.get("email"))
            name = self.validate_text(payload.get("name"), "o nome", 200)
            document = self.validate_text(payload.get("document"), "o CPF ou CNPJ", 30)
            phone = self.validate_text(payload.get("phone", ""), "o telefone", 40, required=False)
            address = self.validate_text(payload.get("address", ""), "o endereço", 300, required=False)
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError, AttributeError) as error:
            self.send_json(400, {"error": str(error) or "Os dados da conta são inválidos."})
            return

        try:
            with sqlite3.connect(DATABASE) as connection:
                cursor = connection.execute(
                    """
                    UPDATE accounts
                    SET email = ?, name = ?, document = ?, phone = ?, address = ?
                    WHERE email = ?
                    """,
                    (email, name, document, phone, address, old_email),
                )
                if cursor.rowcount == 0:
                    self.send_json(404, {"error": "Conta não encontrada."})
                    return
                if email != old_email:
                    for table in (
                        "transactions", "products", "sales", "team_members",
                        "pricing_calculations", "pricing_drafts"
                    ):
                        connection.execute(
                            f"UPDATE {table} SET owner_email = ? WHERE owner_email = ?",
                            (email, old_email),
                        )
                connection.row_factory = sqlite3.Row
                account = connection.execute(
                    "SELECT email, name, document, phone, address FROM accounts WHERE email = ?",
                    (email,),
                ).fetchone()
        except sqlite3.IntegrityError:
            self.send_json(409, {"error": "Já existe uma conta cadastrada com este e-mail."})
            return
        except sqlite3.Error:
            self.send_json(500, {"error": "Não foi possível atualizar a conta no banco SQLite."})
            return
        self.send_json(200, {"user": self.public_account(account), "message": "Cadastro atualizado com sucesso."})

    def save_pricing_calculation(self, calculation_id=None):
        try:
            payload = self.read_json_payload()
            owner_email = self.account_email(payload.get("email"))
            legacy_id = payload.get("legacyId")
            if legacy_id is not None:
                legacy_id = self.validate_text(legacy_id, "o identificador antigo", 100)
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError, AttributeError) as error:
            self.send_json(400, {"error": str(error) or "Os dados do cálculo são inválidos."})
            return

        try:
            with sqlite3.connect(DATABASE) as connection:
                calculation = self.save_calculation(
                    connection, owner_email, payload, calculation_id, legacy_id
                )
        except (ValueError, json.JSONDecodeError, TypeError) as error:
            self.send_json(400, {"error": str(error) or "Os dados do cálculo são inválidos."})
            return
        except sqlite3.IntegrityError:
            self.send_json(409, {"error": "Este cálculo já foi importado."})
            return
        except sqlite3.Error:
            self.send_json(500, {"error": "Não foi possível salvar o cálculo no banco SQLite."})
            return
        if calculation is None:
            self.send_json(404, {"error": "Cálculo não encontrado."})
            return
        self.send_json(201 if calculation_id is None else 200, {"calculation": calculation})

    def save_pricing_draft(self):
        try:
            payload = self.read_json_payload(maximum_length=262_144)
            owner_email = self.account_email(payload.get("email"))
            draft = payload.get("draft")
            if not isinstance(draft, dict):
                raise ValueError("O rascunho de precificação é inválido.")
            for key, maximum in (
                ("serviceName", 120), ("hourlyRate", 64), ("mat", 64), ("labor", 64),
                ("markup", 64), ("tax", 64),
            ):
                value = draft.get(key, "")
                if value is None:
                    value = ""
                if not isinstance(value, (str, int, float)) or isinstance(value, bool):
                    raise ValueError("Um dos campos do rascunho é inválido.")
                value = str(value)
                if len(value) > maximum:
                    raise ValueError("Um dos campos do rascunho excede o limite permitido.")
                draft[key] = value
            if (
                not isinstance(draft.get("businessModel"), str)
                or draft["businessModel"] not in {"produto", "servico"}
            ):
                raise ValueError("Selecione produto ou serviço.")
            costs = draft.get("costs", [])
            if not isinstance(costs, list) or len(costs) > 200:
                raise ValueError("A lista de custos do rascunho é inválida.")
            normalized_costs = []
            for cost in costs:
                if not isinstance(cost, dict):
                    raise ValueError("Um dos custos do rascunho é inválido.")
                cost_id = cost.get("id")
                if not isinstance(cost_id, (str, int, float)) or isinstance(cost_id, bool):
                    raise ValueError("Um custo do rascunho não possui identificador válido.")
                cost_name = self.validate_text(cost.get("name"), "a descrição do custo", 200)
                cost_type = cost.get("type")
                cost_model = cost.get("model")
                cost_value = cost.get("value")
                if (
                    not isinstance(cost_type, str)
                    or cost_type not in CALCULATION_COST_TYPES
                    or not isinstance(cost_model, str)
                    or cost_model not in {"produto", "servico"}
                ):
                    raise ValueError("Um custo do rascunho possui tipo inválido.")
                if not isinstance(cost_value, (str, int, float)) or isinstance(cost_value, bool):
                    raise ValueError("O valor de um custo do rascunho é inválido.")
                cost_value_cents = self.non_negative_amount_cents(cost_value, "valor do custo")
                if cost_value_cents == 0:
                    raise ValueError("O valor de um custo do rascunho deve ser maior que zero.")
                normalized_costs.append(
                    {
                        "id": str(cost_id),
                        "name": cost_name,
                        "type": cost_type,
                        "model": cost_model,
                        "value": str(Decimal(cost_value_cents) / Decimal(100)),
                    }
                )
            draft["costs"] = normalized_costs
            draft_json = json.dumps(draft, ensure_ascii=False, separators=(",", ":"))
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError, AttributeError) as error:
            self.send_json(400, {"error": str(error) or "O rascunho enviado é inválido."})
            return

        try:
            with sqlite3.connect(DATABASE) as connection:
                connection.execute(
                    """
                    INSERT INTO pricing_drafts (owner_email, draft_json, updated_at)
                    VALUES (?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(owner_email) DO UPDATE SET
                        draft_json = excluded.draft_json,
                        updated_at = CURRENT_TIMESTAMP
                    """,
                    (owner_email, draft_json),
                )
        except sqlite3.Error:
            self.send_json(500, {"error": "Não foi possível salvar o rascunho no banco SQLite."})
            return
        self.send_json(200, {"message": "Rascunho salvo no banco SQLite."})

    def import_pricing_calculations(self):
        try:
            payload = self.read_json_payload(maximum_length=1_048_576)
            owner_email = self.account_email(payload.get("email"))
            calculations = payload.get("calculations")
            if not isinstance(calculations, list) or len(calculations) > 500:
                raise ValueError("A lista de cálculos antigos é inválida.")
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError, AttributeError) as error:
            self.send_json(400, {"error": str(error) or "Os dados antigos são inválidos."})
            return

        imported = 0
        try:
            with sqlite3.connect(DATABASE) as connection:
                for calculation in calculations:
                    if not isinstance(calculation, dict):
                        raise ValueError("Um dos cálculos antigos é inválido.")
                    legacy_id = self.validate_text(
                        str(calculation.get("id", "")), "o identificador antigo", 100
                    )
                    exists = connection.execute(
                        "SELECT 1 FROM pricing_calculations WHERE owner_email = ? AND legacy_id = ?",
                        (owner_email, legacy_id),
                    ).fetchone()
                    if exists:
                        continue
                    self.save_calculation(connection, owner_email, calculation, legacy_id=legacy_id)
                    imported += 1
        except (ValueError, json.JSONDecodeError, TypeError) as error:
            self.send_json(400, {"error": str(error) or "Não foi possível importar os cálculos antigos."})
            return
        except sqlite3.Error:
            self.send_json(500, {"error": "Não foi possível importar os cálculos para o banco SQLite."})
            return
        self.send_json(200, {"imported": imported, "message": "Histórico importado para o banco SQLite."})

    def save_product(self, product_id=None):
        try:
            payload = self.read_json_payload()
            owner_email = self.get_owner_email({"email": [payload.get("email", "")]})
            kind = payload.get("kind")
            if kind not in {"produto", "servico"}:
                raise ValueError("Selecione produto ou serviço.")
            name = self.validate_text(payload.get("name"), "o nome")
            category = self.validate_text(payload.get("category"), "a categoria", 80)
            description = self.validate_text(
                payload.get("description", ""), "a descrição", 500, required=False
            )
            price_cents = self.validate_amount_cents(payload.get("price"))
            stock = payload.get("stock")
            if kind == "produto" and stock is not None:
                if isinstance(stock, bool) or not isinstance(stock, int) or stock < 0:
                    raise ValueError("O estoque deve ser um número inteiro igual ou maior que zero.")
            elif kind == "servico":
                stock = None
            else:
                stock = None
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError, AttributeError) as error:
            self.send_json(400, {"error": str(error) or "Os dados do item são inválidos."})
            return

        with sqlite3.connect(DATABASE) as connection:
            if product_id is not None:
                cursor = connection.execute(
                    """
                    UPDATE products
                    SET kind = ?, name = ?, category = ?, description = ?,
                        price_cents = ?, stock_quantity = ?
                    WHERE id = ? AND owner_email = ?
                    """,
                    (kind, name, category, description, price_cents, stock, product_id, owner_email),
                )
                if cursor.rowcount == 0:
                    self.send_json(404, {"error": "Item do catálogo não encontrado."})
                    return
                status = 200
            else:
                cursor = connection.execute(
                    """
                    INSERT INTO products
                        (owner_email, kind, name, category, description, price_cents, stock_quantity)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (owner_email, kind, name, category, description, price_cents, stock),
                )
                product_id = cursor.lastrowid
                status = 201
        self.send_json(status, {"id": product_id, "message": "Item do catálogo salvo."})

    def save_team_member(self, member_id=None):
        try:
            payload = self.read_json_payload()
            owner_email = self.get_owner_email({"email": [payload.get("email", "")]})
            name = self.validate_text(payload.get("name"), "o nome")
            role = self.validate_text(payload.get("role"), "o cargo", 80)
            member_email = self.validate_text(payload.get("member_email"), "um e-mail", 254).lower()
            if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", member_email):
                raise ValueError("Informe um e-mail válido para o integrante.")
            phone = self.validate_text(payload.get("phone", ""), "o telefone", 40, required=False)
            status_value = payload.get("status", "ativo")
            if status_value not in {"ativo", "inativo"}:
                raise ValueError("Selecione uma situação válida para o integrante.")
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError, AttributeError) as error:
            self.send_json(400, {"error": str(error) or "Os dados do integrante são inválidos."})
            return

        try:
            with sqlite3.connect(DATABASE) as connection:
                if member_id is None:
                    cursor = connection.execute(
                        """
                        INSERT INTO team_members (owner_email, name, role, email, phone, status)
                        VALUES (?, ?, ?, ?, ?, ?)
                        """,
                        (owner_email, name, role, member_email, phone, status_value),
                    )
                    member_id = cursor.lastrowid
                    response_status = 201
                else:
                    cursor = connection.execute(
                        """
                        UPDATE team_members
                        SET name = ?, role = ?, email = ?, phone = ?, status = ?
                        WHERE id = ? AND owner_email = ?
                        """,
                        (name, role, member_email, phone, status_value, member_id, owner_email),
                    )
                    if cursor.rowcount == 0:
                        self.send_json(404, {"error": "Integrante da equipe não encontrado."})
                        return
                    response_status = 200
        except sqlite3.IntegrityError:
            self.send_json(409, {"error": "Já existe um integrante cadastrado com esse e-mail."})
            return
        self.send_json(response_status, {"id": member_id, "message": "Integrante salvo."})

    def save_sale(self):
        try:
            payload = self.read_json_payload()
            owner_email = self.get_owner_email({"email": [payload.get("email", "")]})
            product_id = payload.get("product_id")
            quantity = payload.get("quantity")
            customer_name = self.validate_text(
                payload.get("customer_name", ""), "o nome do cliente", 200, required=False
            ) or "Cliente não informado"
            sale_date = self.validate_date(payload.get("date"), "data da venda")
            status_value = payload.get("status", "pendente")
            if product_id is not None and (
                isinstance(product_id, bool) or not isinstance(product_id, int) or product_id <= 0
            ):
                raise ValueError("Selecione um item válido do catálogo ou uma venda avulsa.")
            if isinstance(quantity, bool) or not isinstance(quantity, int) or not 1 <= quantity <= 1_000_000:
                raise ValueError("A quantidade deve ser um número inteiro maior que zero.")
            if not isinstance(status_value, str) or status_value not in {"pendente", "paga"}:
                raise ValueError("Selecione venda pendente ou paga.")
            if product_id is None:
                product_name = self.validate_text(payload.get("item_name"), "o nome do item")
                product_kind = payload.get("item_kind")
                if product_kind not in {"produto", "servico"}:
                    raise ValueError("Selecione se o item avulso é um produto ou serviço.")
                unit_price_cents = self.validate_amount_cents(payload.get("unit_price"))
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError, AttributeError) as error:
            self.send_json(400, {"error": str(error) or "Os dados da venda são inválidos."})
            return

        try:
            with sqlite3.connect(DATABASE) as connection:
                connection.row_factory = sqlite3.Row
                product = None
                if product_id is not None:
                    product = connection.execute(
                        "SELECT * FROM products WHERE id = ? AND owner_email = ?",
                        (product_id, owner_email),
                    ).fetchone()
                    if not product:
                        self.send_json(404, {"error": "O item selecionado não está no seu catálogo."})
                        return
                    if product["stock_quantity"] is not None and product["stock_quantity"] < quantity:
                        self.send_json(409, {"error": f"Estoque insuficiente. Disponível: {product['stock_quantity']}."})
                        return

                    product_name = product["name"]
                    product_kind = product["kind"]
                    unit_price_cents = product["price_cents"]
                total_cents = unit_price_cents * quantity
                if total_cents > int(MAX_AMOUNT * 100):
                    self.send_json(400, {"error": "O total da venda excede o limite permitido."})
                    return
                if product is not None and product["stock_quantity"] is not None:
                    connection.execute(
                        "UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?",
                        (quantity, product_id),
                    )
                cursor = connection.execute(
                    """
                    INSERT INTO sales (
                        owner_email, product_id, product_name, product_kind, quantity,
                        unit_price_cents, total_cents, customer_name, sale_date, status
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        owner_email, product_id, product_name, product_kind, quantity,
                        unit_price_cents, total_cents, customer_name, sale_date, status_value,
                    ),
                )
                sale_id = cursor.lastrowid
                if status_value == "paga":
                    connection.execute(
                        """
                        INSERT INTO transactions (
                            owner_email, type, description, category, amount_cents,
                            transaction_date, status, source_type, source_id
                        ) VALUES (?, 'entrada', ?, 'Venda', ?, ?, 'confirmada', 'sale', ?)
                        """,
                        (owner_email, f"Venda #{sale_id} - {product_name}", total_cents, sale_date, sale_id),
                    )
        except sqlite3.Error:
            self.send_json(500, {"error": "Não foi possível salvar a venda no banco SQLite."})
            return
        self.send_json(201, {"id": sale_id, "message": "Venda registrada."})

    def update_sale_status(self, sale_id):
        try:
            payload = self.read_json_payload()
            owner_email = self.get_owner_email({"email": [payload.get("email", "")]})
            new_status = payload.get("status")
            if not isinstance(new_status, str) or new_status not in {"paga", "cancelada"}:
                raise ValueError("Selecione pagamento confirmado ou venda cancelada.")
            sale_date = self.validate_date(payload.get("date"), "data do recebimento")
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError, AttributeError) as error:
            self.send_json(400, {"error": str(error) or "A situação da venda é inválida."})
            return

        with sqlite3.connect(DATABASE) as connection:
            connection.row_factory = sqlite3.Row
            sale = connection.execute(
                "SELECT * FROM sales WHERE id = ? AND owner_email = ?",
                (sale_id, owner_email),
            ).fetchone()
            if not sale:
                self.send_json(404, {"error": "Venda não encontrada."})
                return
            if sale["status"] != "pendente":
                self.send_json(409, {"error": "Somente vendas pendentes podem ser atualizadas."})
                return

            connection.execute("UPDATE sales SET status = ? WHERE id = ?", (new_status, sale_id))
            if new_status == "paga":
                connection.execute(
                    """
                    INSERT INTO transactions (
                        owner_email, type, description, category, amount_cents,
                        transaction_date, status, source_type, source_id
                    ) VALUES (?, 'entrada', ?, 'Venda', ?, ?, 'confirmada', 'sale', ?)
                    """,
                    (
                        owner_email, f"Venda #{sale_id} - {sale['product_name']}",
                        sale["total_cents"], sale_date, sale_id,
                    ),
                )
            elif sale["product_id"] is not None and sale["product_kind"] == "produto":
                connection.execute(
                    """
                    UPDATE products
                    SET stock_quantity = stock_quantity + ?
                    WHERE id = ? AND owner_email = ? AND stock_quantity IS NOT NULL
                    """,
                    (sale["quantity"], sale["product_id"], owner_email),
                )
        self.send_json(200, {"message": "Situação da venda atualizada."})

    def create_payment_link(self, sale_id):
        try:
            payload = self.read_json_payload()
            owner_email = self.get_owner_email({"email": [payload.get("email", "")]})
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError, AttributeError) as error:
            self.send_json(400, {"error": str(error) or "Não foi possível validar a conta."})
            return

        with sqlite3.connect(DATABASE) as connection:
            connection.row_factory = sqlite3.Row
            sale = connection.execute(
                "SELECT * FROM sales WHERE id = ? AND owner_email = ?",
                (sale_id, owner_email),
            ).fetchone()
            if not sale:
                self.send_json(404, {"error": "Venda não encontrada."})
                return
            if sale["status"] != "pendente":
                self.send_json(409, {"error": "Só é possível gerar cobrança para uma venda pendente."})
                return
            if sale["payment_url"]:
                self.send_json(
                    200,
                    {
                        "id": sale["payment_preference_id"],
                        "url": sale["payment_url"],
                        "message": "Link de pagamento já existente.",
                    },
                )
                return

        access_token = os.environ.get("MP_ACCESS_TOKEN", "").strip()
        if not access_token:
            self.send_json(
                503,
                {
                    "error": (
                        "Para gerar cobranças reais, configure MP_ACCESS_TOKEN no ambiente "
                        "do servidor com um token privado de produção ou teste do Mercado Pago."
                    )
                },
            )
            return

        preference = {
            "items": [
                {
                    "title": sale["product_name"][:256],
                    "quantity": sale["quantity"],
                    "unit_price": sale["unit_price_cents"] / 100,
                    "currency_id": "BRL",
                }
            ],
            "external_reference": f"infinity-price-sale-{sale_id}",
            "metadata": {
                "owner_email": owner_email,
                "sale_id": sale_id,
            },
        }
        request = urllib.request.Request(
            "https://api.mercadopago.com/checkout/preferences",
            data=json.dumps(preference).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
                "X-Idempotency-Key": str(uuid4()),
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                mercado_response = json.loads(response.read())
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            self.send_json(
                502,
                {"error": "O Mercado Pago não conseguiu gerar o link. Confira sua conexão e o token configurado."},
            )
            return

        preference_id = mercado_response.get("id")
        payment_url = mercado_response.get("init_point")
        if not isinstance(preference_id, str) or not isinstance(payment_url, str) or not payment_url.startswith("https://"):
            self.send_json(502, {"error": "O Mercado Pago não retornou um link de pagamento válido."})
            return

        with sqlite3.connect(DATABASE) as connection:
            cursor = connection.execute(
                """
                UPDATE sales SET payment_preference_id = ?, payment_url = ?
                WHERE id = ? AND owner_email = ? AND status = 'pendente'
                    AND payment_url IS NULL
                """,
                (preference_id, payment_url, sale_id, owner_email),
            )
            if cursor.rowcount == 0:
                current = connection.execute(
                    "SELECT payment_preference_id, payment_url FROM sales WHERE id = ? AND owner_email = ?",
                    (sale_id, owner_email),
                ).fetchone()
                if not current:
                    self.send_json(404, {"error": "Venda não encontrada."})
                    return
                if current["payment_url"]:
                    preference_id = current["payment_preference_id"]
                    payment_url = current["payment_url"]
                else:
                    self.send_json(409, {"error": "A venda foi alterada e não pode mais receber uma cobrança."})
                    return
        self.send_json(201, {"id": preference_id, "url": payment_url, "message": "Link de pagamento criado."})

    def create_demo_payment_link(self, sale_id):
        try:
            payload = self.read_json_payload()
            owner_email = self.get_owner_email({"email": [payload.get("email", "")]})
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError, AttributeError) as error:
            self.send_json(400, {"error": str(error) or "Não foi possível validar a conta."})
            return

        try:
            with sqlite3.connect(DATABASE) as connection:
                connection.row_factory = sqlite3.Row
                sale = connection.execute(
                    "SELECT status, demo_payment_token FROM sales WHERE id = ? AND owner_email = ?",
                    (sale_id, owner_email),
                ).fetchone()
                if not sale:
                    self.send_json(404, {"error": "Venda não encontrada."})
                    return
                if sale["status"] != "pendente":
                    self.send_json(409, {"error": "Só é possível criar um link de demonstração para uma venda pendente."})
                    return

                token = sale["demo_payment_token"]
                if not token:
                    token = uuid4().hex
                    connection.execute(
                        """
                        UPDATE sales SET demo_payment_token = ?
                        WHERE id = ? AND owner_email = ? AND status = 'pendente'
                            AND demo_payment_token IS NULL
                        """,
                        (token, sale_id, owner_email),
                    )
                    current = connection.execute(
                        "SELECT demo_payment_token, status FROM sales WHERE id = ? AND owner_email = ?",
                        (sale_id, owner_email),
                    ).fetchone()
                    if current["status"] != "pendente":
                        self.send_json(409, {"error": "A venda foi alterada e não pode mais receber uma cobrança."})
                        return
                    token = current["demo_payment_token"]
        except sqlite3.Error:
            self.send_json(500, {"error": "Não foi possível criar o link de demonstração no banco SQLite."})
            return

        self.send_json(
            200,
            {
                "url": f"/demo-payment/{token}",
                "message": "Link fictício criado. Ele serve apenas para demonstração e não recebe pagamentos.",
            },
        )

    def serve_demo_payment_page(self, token):
        try:
            with sqlite3.connect(DATABASE) as connection:
                connection.row_factory = sqlite3.Row
                sale = connection.execute(
                    """
                    SELECT id, product_name, quantity, unit_price_cents, total_cents,
                           customer_name, sale_date, status
                    FROM sales WHERE demo_payment_token = ?
                    """,
                    (token,),
                ).fetchone()
        except sqlite3.Error:
            self.send_error(500, "Não foi possível carregar a demonstração de cobrança.")
            return

        if not sale:
            self.send_error(404, "Link de demonstração não encontrado.")
            return

        format_brl = lambda cents: (
            f"R$ {Decimal(cents) / Decimal(100):,.2f}"
            .replace(",", "_").replace(".", ",").replace("_", ".")
        )
        sale_status = {
            "pendente": "Aguardando pagamento",
            "paga": "Venda marcada como paga no sistema",
            "cancelada": "Cobrança encerrada",
        }[sale["status"]]
        html_content = f"""<!DOCTYPE html>
<html lang="pt-br">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Cobrança demonstrativa | Infinity Price</title>
    <style>
        * {{ box-sizing: border-box; }}
        body {{ margin: 0; padding: 32px 16px; background: #f3f4fb; color: #242942; font-family: Arial, sans-serif; }}
        main {{ width: min(100%, 520px); margin: 5vh auto; padding: 32px; border: 1px solid #e5e7f0; border-radius: 20px; background: #fff; box-shadow: 0 16px 48px #29305712; }}
        .brand {{ margin: 0 0 24px; color: #5953ac; font-size: 14px; font-weight: 700; }}
        .badge {{ display: inline-block; padding: 8px 11px; border-radius: 999px; background: #fff1d6; color: #855300; font-size: 12px; font-weight: 700; letter-spacing: .04em; }}
        h1 {{ margin: 18px 0 8px; font-size: 25px; }}
        .notice {{ margin: 18px 0; padding: 14px; border-radius: 12px; background: #fff8e9; color: #654b1d; font-size: 14px; line-height: 1.5; }}
        dl {{ margin: 24px 0; }}
        .row {{ display: flex; justify-content: space-between; gap: 16px; padding: 12px 0; border-bottom: 1px solid #edf0f5; }}
        dt {{ color: #687087; }}
        dd {{ margin: 0; text-align: right; font-weight: 600; }}
        .total {{ color: #272d57; font-size: 22px; font-weight: 800; }}
        footer {{ margin-top: 24px; color: #687087; font-size: 12px; line-height: 1.5; }}
    </style>
</head>
<body>
    <main>
        <p class="brand">Infinity Price</p>
        <span class="badge">LINK FICTÍCIO · DEMONSTRAÇÃO</span>
        <h1>Resumo da cobrança</h1>
        <p>Olá, {html.escape(sale["customer_name"])}. Confira os detalhes abaixo.</p>
        <p class="notice"><strong>Este link é apenas uma demonstração.</strong> Não é uma cobrança real, não aceita pagamentos e não gera confirmação financeira.</p>
        <dl>
            <div class="row"><dt>Pedido</dt><dd>#{sale["id"]}</dd></div>
            <div class="row"><dt>Item</dt><dd>{html.escape(sale["product_name"])}</dd></div>
            <div class="row"><dt>Quantidade</dt><dd>{sale["quantity"]}</dd></div>
            <div class="row"><dt>Valor unitário</dt><dd>{format_brl(sale["unit_price_cents"])}</dd></div>
            <div class="row"><dt>Total</dt><dd class="total">{format_brl(sale["total_cents"])}</dd></div>
            <div class="row"><dt>Situação</dt><dd>{sale_status}</dd></div>
        </dl>
        <footer>Endereço de demonstração local. Como o sistema está no localhost, este link só abre neste computador e não pode ser usado pelo cliente em outro dispositivo.</footer>
    </main>
</body>
</html>"""
        encoded = html_content.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self):
        parsed = urlparse(self.path)
        demo_payment_match = re.fullmatch(r"/demo-payment/([0-9a-f]{32})", parsed.path)
        if demo_payment_match:
            self.serve_demo_payment_page(demo_payment_match.group(1))
            return
        if parsed.path == "/api/pricing-draft":
            try:
                owner_email = self.account_email(parse_qs(parsed.query).get("email", [""])[0])
            except ValueError as error:
                self.send_json(400, {"error": str(error)})
                return
            try:
                with sqlite3.connect(DATABASE) as connection:
                    row = connection.execute(
                        "SELECT draft_json FROM pricing_drafts WHERE owner_email = ?",
                        (owner_email,),
                    ).fetchone()
            except sqlite3.Error:
                self.send_json(500, {"error": "Não foi possível carregar o rascunho do banco SQLite."})
                return
            try:
                draft = json.loads(row[0]) if row else None
            except (TypeError, json.JSONDecodeError):
                self.send_json(500, {"error": "O rascunho salvo está inválido no banco SQLite."})
                return
            self.send_json(200, {"draft": draft})
            return

        if parsed.path == "/api/account":
            try:
                email = self.account_email(parse_qs(parsed.query).get("email", [""])[0])
            except ValueError as error:
                self.send_json(400, {"error": str(error)})
                return
            try:
                with sqlite3.connect(DATABASE) as connection:
                    connection.row_factory = sqlite3.Row
                    account = connection.execute(
                        "SELECT email, name, document, phone, address FROM accounts WHERE email = ?",
                        (email,),
                    ).fetchone()
            except sqlite3.Error:
                self.send_json(500, {"error": "Não foi possível acessar as contas no banco SQLite."})
                return
            if not account:
                self.send_json(404, {"error": "Conta não encontrada."})
                return
            self.send_json(200, {"user": self.public_account(account)})
            return

        if parsed.path == "/api/calculations":
            try:
                owner_email = self.account_email(parse_qs(parsed.query).get("email", [""])[0])
            except ValueError as error:
                self.send_json(400, {"error": str(error)})
                return
            try:
                with sqlite3.connect(DATABASE) as connection:
                    connection.row_factory = sqlite3.Row
                    rows = connection.execute(
                        """
                        SELECT * FROM pricing_calculations
                        WHERE owner_email = ? ORDER BY updated_at DESC, id DESC
                        """,
                        (owner_email,),
                    ).fetchall()
            except sqlite3.Error:
                self.send_json(500, {"error": "Não foi possível carregar o histórico do banco SQLite."})
                return
            try:
                calculations = [self.calculation_response(row) for row in rows]
            except (KeyError, TypeError, json.JSONDecodeError):
                self.send_json(500, {"error": "O histórico contém um cálculo inválido no banco SQLite."})
                return
            self.send_json(200, {"calculations": calculations})
            return

        if parsed.path == "/api/transactions":
            try:
                owner_email = self.get_owner_email(parse_qs(parsed.query))
            except ValueError as error:
                self.send_json(400, {"error": str(error)})
                return

            with sqlite3.connect(DATABASE) as connection:
                connection.row_factory = sqlite3.Row
                rows = connection.execute(
                    """
                    SELECT id, type, description, category, amount_cents,
                           transaction_date, status, source_type
                    FROM transactions
                    WHERE owner_email = ?
                    ORDER BY transaction_date DESC, id DESC
                    """,
                    (owner_email,),
                ).fetchall()
            self.send_json(
                200,
                {
                    "transactions": [
                        {
                            "id": row["id"],
                            "type": row["type"],
                            "description": row["description"],
                            "category": row["category"],
                            "amount": row["amount_cents"] / 100,
                            "date": row["transaction_date"],
                            "status": row["status"],
                            "source_type": row["source_type"],
                        }
                        for row in rows
                    ]
                },
            )
            return

        if parsed.path in {"/api/products", "/api/sales", "/api/team"}:
            try:
                owner_email = self.get_owner_email(parse_qs(parsed.query))
            except ValueError as error:
                self.send_json(400, {"error": str(error)})
                return
            with sqlite3.connect(DATABASE) as connection:
                connection.row_factory = sqlite3.Row
                if parsed.path == "/api/products":
                    rows = connection.execute(
                        """
                        SELECT id, kind, name, category, description, price_cents, stock_quantity
                        FROM products WHERE owner_email = ? ORDER BY name COLLATE NOCASE
                        """,
                        (owner_email,),
                    ).fetchall()
                    result = {
                        "products": [
                            {
                                "id": row["id"], "kind": row["kind"], "name": row["name"],
                                "category": row["category"], "description": row["description"],
                                "price": row["price_cents"] / 100, "stock": row["stock_quantity"],
                            }
                            for row in rows
                        ]
                    }
                elif parsed.path == "/api/sales":
                    rows = connection.execute(
                        """
                        SELECT id, product_id, product_name, product_kind, quantity, unit_price_cents,
                               total_cents, customer_name, sale_date, status, payment_url,
                               payment_preference_id, demo_payment_token
                        FROM sales WHERE owner_email = ? ORDER BY sale_date DESC, id DESC
                        """,
                        (owner_email,),
                    ).fetchall()
                    result = {
                        "sales": [
                            {
                                "id": row["id"], "product_id": row["product_id"],
                                "product_name": row["product_name"], "product_kind": row["product_kind"],
                                "quantity": row["quantity"], "unit_price": row["unit_price_cents"] / 100,
                                "total": row["total_cents"] / 100, "customer_name": row["customer_name"],
                                "date": row["sale_date"], "status": row["status"],
                                "payment_url": row["payment_url"],
                                "payment_preference_id": row["payment_preference_id"],
                                "demo_payment_url": (
                                    f"/demo-payment/{row['demo_payment_token']}"
                                    if row["demo_payment_token"] else None
                                ),
                            }
                            for row in rows
                        ]
                    }
                else:
                    rows = connection.execute(
                        """
                        SELECT id, name, role, email, phone, status
                        FROM team_members WHERE owner_email = ? ORDER BY name COLLATE NOCASE
                        """,
                        (owner_email,),
                    ).fetchall()
                    result = {
                        "members": [
                            {
                                "id": row["id"], "name": row["name"], "role": row["role"],
                                "email": row["email"], "phone": row["phone"], "status": row["status"],
                            }
                            for row in rows
                        ]
                    }
            self.send_json(200, result)
            return

        self.serve_static_file(parsed.path)

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/auth/register":
            self.register_account()
            return
        if path == "/api/auth/login":
            self.login_account()
            return
        if path == "/api/calculations":
            self.save_pricing_calculation()
            return
        if path == "/api/pricing-draft":
            self.save_pricing_draft()
            return
        if path == "/api/calculations/import":
            self.import_pricing_calculations()
            return
        sale_payment_match = re.fullmatch(r"/api/sales/(\d+)/payment-link", path)
        if sale_payment_match:
            self.create_payment_link(int(sale_payment_match.group(1)))
            return
        demo_payment_match = re.fullmatch(r"/api/sales/(\d+)/demo-payment-link", path)
        if demo_payment_match:
            self.create_demo_payment_link(int(demo_payment_match.group(1)))
            return
        if path == "/api/products":
            self.save_product()
            return
        if path == "/api/team":
            self.save_team_member()
            return
        if path == "/api/sales":
            self.save_sale()
            return
        if path != "/api/transactions":
            self.send_json(404, {"error": "Rota não encontrada."})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 16_384:
                raise ValueError("O lançamento enviado é inválido.")
            payload = json.loads(self.rfile.read(length))
            owner_email = self.get_owner_email({"email": [payload.get("email", "")]})
            transaction_type = payload.get("type")
            description = payload.get("description", "").strip()
            category = payload.get("category", "").strip()
            transaction_date = payload.get("date", "")
            status = payload.get("status")
            amount = payload.get("amount")

            if not isinstance(transaction_type, str) or transaction_type not in TRANSACTION_TYPES:
                raise ValueError("Selecione entrada ou saída.")
            if not isinstance(description, str) or not description or len(description) > 200:
                raise ValueError("A descrição deve ter entre 1 e 200 caracteres.")
            if not isinstance(category, str) or not category or len(category) > 80:
                raise ValueError("A categoria deve ter entre 1 e 80 caracteres.")
            if not isinstance(status, str) or status not in TRANSACTION_STATUSES:
                raise ValueError("Selecione um status válido.")
            if not isinstance(amount, (int, float)) or isinstance(amount, bool):
                raise ValueError("Informe um valor válido.")
            try:
                amount_decimal = Decimal(str(amount))
            except InvalidOperation:
                raise ValueError("Informe um valor válido.") from None
            if not amount_decimal.is_finite() or amount_decimal <= 0 or amount_decimal > MAX_AMOUNT:
                raise ValueError("O valor deve ser maior que zero e menor que R$ 1 bilhão.")
            if amount_decimal < Decimal("0.01"):
                raise ValueError("O valor mínimo é R$ 0,01.")
            if amount_decimal.as_tuple().exponent < -2:
                raise ValueError("Informe no máximo duas casas decimais.")
            try:
                parsed_date = date.fromisoformat(transaction_date)
            except (TypeError, ValueError):
                raise ValueError("Informe uma data válida.") from None
            if parsed_date.isoformat() != transaction_date:
                raise ValueError("Informe uma data válida.")
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError, AttributeError) as error:
            self.send_json(400, {"error": str(error) or "O lançamento enviado é inválido."})
            return

        amount_cents = int((amount_decimal * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
        if amount_cents <= 0:
            self.send_json(400, {"error": "O valor deve ser de pelo menos R$ 0,01."})
            return

        with sqlite3.connect(DATABASE) as connection:
            cursor = connection.execute(
                """
                INSERT INTO transactions (
                    owner_email, type, description, category, amount_cents,
                    transaction_date, status
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    owner_email,
                    transaction_type,
                    description,
                    category,
                    amount_cents,
                    transaction_date,
                    status,
                ),
            )
        self.send_json(201, {"id": cursor.lastrowid, "message": "Lançamento registrado."})

    def do_DELETE(self):
        parsed = urlparse(self.path)
        product_match = re.fullmatch(r"/api/products/(\d+)", parsed.path)
        member_match = re.fullmatch(r"/api/team/(\d+)", parsed.path)
        transaction_match = re.fullmatch(r"/api/transactions/(\d+)", parsed.path)
        if product_match or member_match:
            try:
                owner_email = self.get_owner_email(parse_qs(parsed.query))
            except ValueError as error:
                self.send_json(400, {"error": str(error)})
                return
            with sqlite3.connect(DATABASE) as connection:
                if product_match:
                    product_id = int(product_match.group(1))
                    has_sales = connection.execute(
                        "SELECT 1 FROM sales WHERE product_id = ? AND owner_email = ? LIMIT 1",
                        (product_id, owner_email),
                    ).fetchone()
                    if has_sales:
                        self.send_json(409, {"error": "Este item já tem vendas. Mantenha-o no catálogo para preservar o histórico."})
                        return
                    cursor = connection.execute(
                        "DELETE FROM products WHERE id = ? AND owner_email = ?",
                        (product_id, owner_email),
                    )
                    missing_message = "Item do catálogo não encontrado."
                    success_message = "Item removido do catálogo."
                else:
                    cursor = connection.execute(
                        "DELETE FROM team_members WHERE id = ? AND owner_email = ?",
                        (int(member_match.group(1)), owner_email),
                    )
                    missing_message = "Integrante da equipe não encontrado."
                    success_message = "Integrante removido."
            if cursor.rowcount == 0:
                self.send_json(404, {"error": missing_message})
                return
            self.send_json(200, {"message": success_message})
            return

        match = re.fullmatch(r"/api/transactions/(\d+)", parsed.path)
        if not match:
            self.send_json(404, {"error": "Rota não encontrada."})
            return

        try:
            owner_email = self.get_owner_email(parse_qs(parsed.query))
        except ValueError as error:
            self.send_json(400, {"error": str(error)})
            return

        with sqlite3.connect(DATABASE) as connection:
            cursor = connection.execute(
                """
                DELETE FROM transactions
                WHERE id = ? AND owner_email = ? AND source_type = 'manual'
                """,
                (int(match.group(1)), owner_email),
            )
        if cursor.rowcount == 0:
            self.send_json(404, {"error": "Lançamento não encontrado."})
            return
        self.send_json(200, {"message": "Lançamento excluído."})

    def do_PUT(self):
        path = urlparse(self.path).path
        calculation_match = re.fullmatch(r"/api/calculations/(\d+)", path)
        if path == "/api/account":
            self.update_account()
            return
        if path == "/api/pricing-draft":
            self.save_pricing_draft()
            return
        if calculation_match:
            self.save_pricing_calculation(int(calculation_match.group(1)))
            return
        product_match = re.fullmatch(r"/api/products/(\d+)", path)
        member_match = re.fullmatch(r"/api/team/(\d+)", path)
        sale_match = re.fullmatch(r"/api/sales/(\d+)/status", path)
        if product_match:
            self.save_product(int(product_match.group(1)))
        elif member_match:
            self.save_team_member(int(member_match.group(1)))
        elif sale_match:
            self.update_sale_status(int(sale_match.group(1)))
        else:
            self.send_json(404, {"error": "Rota não encontrada."})

    def serve_static_file(self, url_path):
        relative_path = unquote(url_path).lstrip("/") or "index.html"
        requested_path = (ROOT / relative_path).resolve()
        if not requested_path.is_relative_to(ROOT) or not requested_path.is_file():
            self.send_error(404)
            return

        content_type, _ = mimetypes.guess_type(requested_path.name)
        body = requested_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", f"{content_type or 'application/octet-stream'}; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    initialize_database()
    server = ThreadingHTTPServer((HOST, PORT), ApplicationHandler)
    print(f"Infinity Price disponível em http://localhost:{PORT}")
    print(f"Banco SQLite: {DATABASE}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor encerrado.")
    finally:
        server.server_close()
