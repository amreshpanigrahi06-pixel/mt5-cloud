//+------------------------------------------------------------------+
//|                                          AccountMonitor.mq5      |
//|                    MT5 Account Monitor Bridge EA                 |
//|                    Pushes data to Web API                        |
//+------------------------------------------------------------------+
#property copyright "MT5 Monitor Bridge"
#property link      ""
#property version   "1.10"
#property strict

#include <WinHttp\WinHttp.mqh>

//--- Inputs
input group "=== Web API Settings ==="
input string     InpApiBaseUrl      = "https://your-domain.com/api";  // Your deployed API URL
input string     InpApiKey          = "your-api-key-here";             // From web dashboard (Accounts → API Keys)
input int        InpPushInterval    = 5;                               // Seconds between pushes
input bool       InpPushPositions   = true;
input bool       InpPushOrders      = true;
input bool       InpPushHistory     = true;
input bool       InpPushAccount     = true;

input group "=== Filtering ==="
input string     InpSymbolFilter    = "*";     // "*" = all, or "EURUSD,GBPUSD"
input int        InpHistoryDays     = 30;      // Days of history to push initially

input group "=== Debug ==="
input bool       InpDebugLog        = true;

//--- Globals
CWinHttp        g_http;
datetime        g_lastPush = 0;
string          g_accountId = "";
bool            g_initialHistorySent = false;
int             g_lastHistoryDay = -1;

//+------------------------------------------------------------------+
//| Expert Initialization                                            |
//+------------------------------------------------------------------+
int OnInit()
{
   // Generate unique account ID
   long login = AccountInfoInteger(ACCOUNT_LOGIN);
   string server = AccountInfoString(ACCOUNT_SERVER);
   g_accountId = "mt5_" + LongToString(login) + "_" + StringReplace(server, " ", "_");
   
   // Initialize WinHTTP
   if(!g_http.Create())
   {
      Print("ERROR: WinHTTP creation failed: ", GetLastError());
      return INIT_FAILED;
   }
   
   // Set timeouts (connect, send, receive, resolve)
   g_http.SetTimeouts(10000, 10000, 10000, 10000);
   
   // Verify API connectivity
   if(!TestApiConnection())
   {
      Print("WARNING: API connection test failed. Check InpApiBaseUrl and InpApiKey");
      Print("URL: ", InpApiBaseUrl);
   }
   
   Print("=== AccountMonitor Initialized ===");
   Print("Account ID: ", g_accountId);
   Print("Login: ", login, " | Server: ", server);
   Print("API: ", InpApiBaseUrl);
   
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
//| Expert Deinitialization                                          |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   g_http.Close();
   Print("AccountMonitor stopped");
}

//+------------------------------------------------------------------+
//| Expert Tick                                                      |
//+------------------------------------------------------------------+
void OnTick()
{
   datetime now = TimeCurrent();
   if(now - g_lastPush >= InpPushInterval)
   {
      PushAllData();
      g_lastPush = now;
   }
}

//+------------------------------------------------------------------+
//| Test API Connection                                              |
//+------------------------------------------------------------------+
bool TestApiConnection()
{
   string url = InpApiBaseUrl + "/webhook/ping";
   map headers;
   headers["Authorization"] = "Bearer " + InpApiKey;
   headers["X-Account-ID"] = g_accountId;
   
   string response;
   int code = g_http.Get(url, headers, response);
   
   if(InpDebugLog) Print("Health check: HTTP ", code, " - ", response);
   return (code == 200);
}

//+------------------------------------------------------------------+
//| Push All Data to API                                             |
//+------------------------------------------------------------------+
void PushAllData()
{
   // 1. Account info (balance, equity, margin)
   if(InpPushAccount)
      PushAccountInfo();
   
   // 2. Open positions
   if(InpPushPositions)
      PushPositions();
   
   // 3. Pending orders
   if(InpPushOrders)
      PushOrders();
   
   // 4. History (once on start, then daily incremental)
   if(InpPushHistory)
   {
      int dayOfYear = DayOfYear();
      if(!g_initialHistorySent || dayOfYear != g_lastHistoryDay)
      {
         int days = g_initialHistorySent ? 1 : InpHistoryDays;
         PushHistory(days);
         g_initialHistorySent = true;
         g_lastHistoryDay = dayOfYear;
      }
   }
}

//+------------------------------------------------------------------+
//| Push Account Info                                                |
//+------------------------------------------------------------------+
void PushAccountInfo()
{
   JsonValue json = CreateJsonObject();
   json["account_id"] = g_accountId;
   json["login"] = (long)AccountInfoInteger(ACCOUNT_LOGIN);
   json["server"] = AccountInfoString(ACCOUNT_SERVER);
   json["name"] = AccountInfoString(ACCOUNT_NAME);
   json["currency"] = AccountInfoString(ACCOUNT_CURRENCY);
   json["balance"] = AccountInfoDouble(ACCOUNT_BALANCE);
   json["equity"] = AccountInfoDouble(ACCOUNT_EQUITY);
   json["margin"] = AccountInfoDouble(ACCOUNT_MARGIN);
   json["free_margin"] = AccountInfoDouble(ACCOUNT_FREEMARGIN);
   json["margin_level"] = AccountInfoDouble(ACCOUNT_MARGIN_LEVEL);
   json["leverage"] = (long)AccountInfoInteger(ACCOUNT_LEVERAGE);
   json["trade_mode"] = (int)AccountInfoInteger(ACCOUNT_TRADE_MODE);
   json["timestamp"] = TimeCurrent();
   
   SendToApi("/webhook/account", json);
}

//+------------------------------------------------------------------+
//| Push Open Positions                                              |
//+------------------------------------------------------------------+
void PushPositions()
{
   JsonValue positions = CreateJsonArray();
   
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(!PositionSelectByTicket(ticket)) continue;
      
      string symbol = PositionGetString(POSITION_SYMBOL);
      if(!SymbolMatchesFilter(symbol)) continue;
      
      JsonValue pos = CreateJsonObject();
      pos["ticket"] = (long)ticket;
      pos["symbol"] = symbol;
      pos["type"] = (int)PositionGetInteger(POSITION_TYPE); // 0=buy, 1=sell
      pos["volume"] = PositionGetDouble(POSITION_VOLUME);
      pos["price_open"] = PositionGetDouble(POSITION_PRICE_OPEN);
      pos["price_current"] = PositionGetDouble(POSITION_PRICE_CURRENT);
      pos["sl"] = PositionGetDouble(POSITION_SL);
      pos["tp"] = PositionGetDouble(POSITION_TP);
      pos["swap"] = PositionGetDouble(POSITION_SWAP);
      pos["profit"] = PositionGetDouble(POSITION_PROFIT);
      pos["magic"] = (long)PositionGetInteger(POSITION_MAGIC);
      pos["comment"] = PositionGetString(POSITION_COMMENT);
      pos["time_open"] = (long)PositionGetInteger(POSITION_TIME);
      pos["time_update"] = (long)PositionGetInteger(POSITION_TIME_UPDATE);
      
      // Calculate pips
      double pipSize = SymbolInfoDouble(symbol, SYMBOL_POINT) * 10;
      double pips = 0;
      if(PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY)
         pips = (PositionGetDouble(POSITION_PRICE_CURRENT) - PositionGetDouble(POSITION_PRICE_OPEN)) / pipSize;
      else
         pips = (PositionGetDouble(POSITION_PRICE_OPEN) - PositionGetDouble(POSITION_PRICE_CURRENT)) / pipSize;
      pos["pips"] = pips;
      
      positions.Add(pos);
   }
   
   JsonValue payload = CreateJsonObject();
   payload["account_id"] = g_accountId;
   payload["positions"] = positions;
   payload["timestamp"] = TimeCurrent();
   
   SendToApi("/webhook/positions", payload);
}

//+------------------------------------------------------------------+
//| Push Pending Orders                                              |
//+------------------------------------------------------------------+
void PushOrders()
{
   JsonValue orders = CreateJsonArray();
   
   for(int i = OrdersTotal() - 1; i >= 0; i--)
   {
      ulong ticket = OrderGetTicket(i);
      if(!OrderSelect(ticket)) continue;
      
      string symbol = OrderGetString(ORDER_SYMBOL);
      if(!SymbolMatchesFilter(symbol)) continue;
      
      ENUM_ORDER_TYPE type = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
      // Only pending orders (not positions)
      if(type == ORDER_TYPE_BUY || type == ORDER_TYPE_SELL) continue;
      
      JsonValue ord = CreateJsonObject();
      ord["ticket"] = (long)ticket;
      ord["symbol"] = symbol;
      ord["type"] = (int)type;
      ord["volume"] = OrderGetDouble(ORDER_VOLUME_INITIAL);
      ord["price_open"] = OrderGetDouble(ORDER_PRICE_OPEN);
      ord["sl"] = OrderGetDouble(ORDER_SL);
      ord["tp"] = OrderGetDouble(ORDER_TP);
      ord["magic"] = (long)OrderGetInteger(ORDER_MAGIC);
      ord["comment"] = OrderGetString(ORDER_COMMENT);
      ord["time_setup"] = (long)OrderGetInteger(ORDER_TIME_SETUP);
      ord["time_expiration"] = (long)OrderGetInteger(ORDER_TIME_EXPIRATION);
      ord["state"] = (int)OrderGetInteger(ORDER_STATE);
      
      orders.Add(ord);
   }
   
   JsonValue payload = CreateJsonObject();
   payload["account_id"] = g_accountId;
   payload["orders"] = orders;
   payload["timestamp"] = TimeCurrent();
   
   SendToApi("/webhook/orders", payload);
}

//+------------------------------------------------------------------+
//| Push Trade History                                               |
//+------------------------------------------------------------------+
void PushHistory(int daysBack)
{
   datetime from = TimeCurrent() - daysBack * 86400;
   datetime to = TimeCurrent();
   
   if(!HistorySelect(from, to))
   {
      if(InpDebugLog) Print("HistorySelect failed: ", GetLastError());
      return;
   }
   
   JsonValue deals = CreateJsonArray();
   int total = HistoryDealsTotal();
   
   for(int i = 0; i < total; i++)
   {
      ulong ticket = HistoryDealGetTicket(i);
      if(ticket == 0) continue;
      
      string symbol = HistoryDealGetString(ticket, DEAL_SYMBOL);
      if(!SymbolMatchesFilter(symbol)) continue;
      
      ENUM_DEAL_TYPE type = (ENUM_DEAL_TYPE)HistoryDealGetInteger(ticket, DEAL_TYPE);
      // Only entry/exit deals (not balance/credit)
      if(type != DEAL_TYPE_BUY && type != DEAL_TYPE_SELL) continue;
      
      JsonValue deal = CreateJsonObject();
      deal["ticket"] = (long)ticket;
      deal["order_ticket"] = (long)HistoryDealGetInteger(ticket, DEAL_ORDER);
      deal["position_id"] = (long)HistoryDealGetInteger(ticket, DEAL_POSITION_ID);
      deal["symbol"] = symbol;
      deal["type"] = (int)type;
      deal["entry"] = (int)HistoryDealGetInteger(ticket, DEAL_ENTRY);
      deal["volume"] = HistoryDealGetDouble(ticket, DEAL_VOLUME);
      deal["price"] = HistoryDealGetDouble(ticket, DEAL_PRICE);
      deal["profit"] = HistoryDealGetDouble(ticket, DEAL_PROFIT);
      deal["swap"] = HistoryDealGetDouble(ticket, DEAL_SWAP);
      deal["commission"] = HistoryDealGetDouble(ticket, DEAL_COMMISSION);
      deal["fee"] = HistoryDealGetDouble(ticket, DEAL_FEE);
      deal["magic"] = (long)HistoryDealGetInteger(ticket, DEAL_MAGIC);
      deal["comment"] = HistoryDealGetString(ticket, DEAL_COMMENT);
      deal["time"] = (long)HistoryDealGetInteger(ticket, DEAL_TIME);
      
      deals.Add(deal);
   }
   
   JsonValue payload = CreateJsonObject();
   payload["account_id"] = g_accountId;
   payload["deals"] = deals;
   payload["from"] = (long)from;
   payload["to"] = (long)to;
   payload["timestamp"] = TimeCurrent();
   
   SendToApi("/webhook/history", payload);
}

//+------------------------------------------------------------------+
//| Send JSON to API                                                 |
//+------------------------------------------------------------------+
bool SendToApi(string endpoint, JsonValue &payload)
{
   string url = InpApiBaseUrl + endpoint;
   map headers;
   headers["Authorization"] = "Bearer " + InpApiKey;
   headers["Content-Type"] = "application/json";
   headers["X-Account-ID"] = g_accountId;
   
   string jsonStr = JsonSerialize(payload);
   
   if(InpDebugLog) Print("POST ", endpoint, " (", StringLen(jsonStr), " bytes)");
   
   string response;
   int code = g_http.Post(url, headers, jsonStr, response);
   
   if(code == 200 || code == 201)
   {
      if(InpDebugLog) Print("  OK: ", response);
      return true;
   }
   else
   {
      Print("  ERROR HTTP ", code, ": ", response);
      return false;
   }
}

//+------------------------------------------------------------------+
//| Symbol Filter Check                                              |
//+------------------------------------------------------------------+
bool SymbolMatchesFilter(const string symbol)
{
   if(InpSymbolFilter == "*" || InpSymbolFilter == "") return true;
   
   string filters[];
   int count = StringSplit(InpSymbolFilter, ',', filters);
   for(int i = 0; i < count; i++)
   {
      string f = StringTrimLeft(StringTrimRight(filters[i]));
      if(f == symbol) return true;
   }
   return false;
}

//+------------------------------------------------------------------+
//| JSON Helpers (using MQL5 native JSON)                           |
//+------------------------------------------------------------------+
JsonValue CreateJsonObject()
{
   return JsonValue();
}

JsonValue CreateJsonArray()
{
   JsonValue arr;
   arr.Resize(0); // Makes it an array
   return arr;
}

// Simplified JSON serialization for MQL5
string JsonSerialize(JsonValue &value)
{
   // MQL5 JsonValue doesn't have direct serialization
   // We'll build JSON manually for the specific structures we need
   // This is a simplified implementation
   return ""; // Will use manual construction below
}

// Manual JSON construction for each payload type
string BuildAccountJson(JsonValue &data)
{
   // Not used - we build directly in SendToApi
   return "";
}

// Better approach: Build JSON string directly in each Push function
// See PushAccountInfoStr, PushPositionsStr, etc. below

//+------------------------------------------------------------------+
//| Alternative: String-based JSON construction                     |
//+------------------------------------------------------------------+

string PushAccountInfoStr()
{
   string json = "{";
   json += "\"account_id\":\"" + g_accountId + "\",";
   json += "\"login\":" + LongToString((long)AccountInfoInteger(ACCOUNT_LOGIN)) + ",";
   json += "\"server\":\"" + JsonEscape(AccountInfoString(ACCOUNT_SERVER)) + "\",";
   json += "\"name\":\"" + JsonEscape(AccountInfoString(ACCOUNT_NAME)) + "\",";
   json += "\"currency\":\"" + JsonEscape(AccountInfoString(ACCOUNT_CURRENCY)) + "\",";
   json += "\"balance\":" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) + ",";
   json += "\"equity\":" + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2) + ",";
   json += "\"margin\":" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN), 2) + ",";
   json += "\"free_margin\":" + DoubleToString(AccountInfoDouble(ACCOUNT_FREEMARGIN), 2) + ",";
   json += "\"margin_level\":" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_LEVEL), 2) + ",";
   json += "\"leverage\":" + LongToString((long)AccountInfoInteger(ACCOUNT_LEVERAGE)) + ",";
   json += "\"trade_mode\":" + IntegerToString((int)AccountInfoInteger(ACCOUNT_TRADE_MODE)) + ",";
   json += "\"timestamp\":" + LongToString(TimeCurrent());
   json += "}";
   return json;
}

string PushPositionsStr()
{
   string json = "{\"account_id\":\"" + g_accountId + "\",\"positions\":[";
   
   bool first = true;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(!PositionSelectByTicket(ticket)) continue;
      
      string symbol = PositionGetString(POSITION_SYMBOL);
      if(!SymbolMatchesFilter(symbol)) continue;
      
      if(!first) json += ",";
      first = false;
      
      double pipSize = SymbolInfoDouble(symbol, SYMBOL_POINT) * 10;
      double pips = 0;
      if(PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY)
         pips = (PositionGetDouble(POSITION_PRICE_CURRENT) - PositionGetDouble(POSITION_PRICE_OPEN)) / pipSize;
      else
         pips = (PositionGetDouble(POSITION_PRICE_OPEN) - PositionGetDouble(POSITION_PRICE_CURRENT)) / pipSize;
      
      json += "{";
      json += "\"ticket\":" + LongToString((long)ticket) + ",";
      json += "\"symbol\":\"" + JsonEscape(symbol) + "\",";
      json += "\"type\":" + IntegerToString((int)PositionGetInteger(POSITION_TYPE)) + ",";
      json += "\"volume\":" + DoubleToString(PositionGetDouble(POSITION_VOLUME), 2) + ",";
      json += "\"price_open\":" + DoubleToString(PositionGetDouble(POSITION_PRICE_OPEN), 5) + ",";
      json += "\"price_current\":" + DoubleToString(PositionGetDouble(POSITION_PRICE_CURRENT), 5) + ",";
      json += "\"sl\":" + DoubleToString(PositionGetDouble(POSITION_SL), 5) + ",";
      json += "\"tp\":" + DoubleToString(PositionGetDouble(POSITION_TP), 5) + ",";
      json += "\"swap\":" + DoubleToString(PositionGetDouble(POSITION_SWAP), 2) + ",";
      json += "\"profit\":" + DoubleToString(PositionGetDouble(POSITION_PROFIT), 2) + ",";
      json += "\"pips\":" + DoubleToString(pips, 1) + ",";
      json += "\"magic\":" + LongToString((long)PositionGetInteger(POSITION_MAGIC)) + ",";
      json += "\"comment\":\"" + JsonEscape(PositionGetString(POSITION_COMMENT)) + "\",";
      json += "\"time_open\":" + LongToString((long)PositionGetInteger(POSITION_TIME)) + ",";
      json += "\"time_update\":" + LongToString((long)PositionGetInteger(POSITION_TIME_UPDATE));
      json += "}";
   }
   
   json += "],\"timestamp\":" + LongToString(TimeCurrent()) + "}";
   return json;
}

string PushOrdersStr()
{
   string json = "{\"account_id\":\"" + g_accountId + "\",\"orders\":[";
   
   bool first = true;
   for(int i = OrdersTotal() - 1; i >= 0; i--)
   {
      ulong ticket = OrderGetTicket(i);
      if(!OrderSelect(ticket)) continue;
      
      string symbol = OrderGetString(ORDER_SYMBOL);
      if(!SymbolMatchesFilter(symbol)) continue;
      
      ENUM_ORDER_TYPE type = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
      if(type == ORDER_TYPE_BUY || type == ORDER_TYPE_SELL) continue;
      
      if(!first) json += ",";
      first = false;
      
      json += "{";
      json += "\"ticket\":" + LongToString((long)ticket) + ",";
      json += "\"symbol\":\"" + JsonEscape(symbol) + "\",";
      json += "\"type\":" + IntegerToString((int)type) + ",";
      json += "\"volume\":" + DoubleToString(OrderGetDouble(ORDER_VOLUME_INITIAL), 2) + ",";
      json += "\"price_open\":" + DoubleToString(OrderGetDouble(ORDER_PRICE_OPEN), 5) + ",";
      json += "\"sl\":" + DoubleToString(OrderGetDouble(ORDER_SL), 5) + ",";
      json += "\"tp\":" + DoubleToString(OrderGetDouble(ORDER_TP), 5) + ",";
      json += "\"magic\":" + LongToString((long)OrderGetInteger(ORDER_MAGIC)) + ",";
      json += "\"comment\":\"" + JsonEscape(OrderGetString(ORDER_COMMENT)) + "\",";
      json += "\"time_setup\":" + LongToString((long)OrderGetInteger(ORDER_TIME_SETUP)) + ",";
      json += "\"time_expiration\":" + LongToString((long)OrderGetInteger(ORDER_TIME_EXPIRATION)) + ",";
      json += "\"state\":" + IntegerToString((int)OrderGetInteger(ORDER_STATE));
      json += "}";
   }
   
   json += "],\"timestamp\":" + LongToString(TimeCurrent()) + "}";
   return json;
}

string PushHistoryStr(int daysBack)
{
   datetime from = TimeCurrent() - daysBack * 86400;
   datetime to = TimeCurrent();
   
   if(!HistorySelect(from, to))
      return "{}";
   
   string json = "{\"account_id\":\"" + g_accountId + "\",\"deals\":[";
   
   bool first = true;
   int total = HistoryDealsTotal();
   
   for(int i = 0; i < total; i++)
   {
      ulong ticket = HistoryDealGetTicket(i);
      if(ticket == 0) continue;
      
      string symbol = HistoryDealGetString(ticket, DEAL_SYMBOL);
      if(!SymbolMatchesFilter(symbol)) continue;
      
      ENUM_DEAL_TYPE type = (ENUM_DEAL_TYPE)HistoryDealGetInteger(ticket, DEAL_TYPE);
      if(type != DEAL_TYPE_BUY && type != DEAL_TYPE_SELL) continue;
      
      if(!first) json += ",";
      first = false;
      
      json += "{";
      json += "\"ticket\":" + LongToString((long)ticket) + ",";
      json += "\"order_ticket\":" + LongToString((long)HistoryDealGetInteger(ticket, DEAL_ORDER)) + ",";
      json += "\"position_id\":" + LongToString((long)HistoryDealGetInteger(ticket, DEAL_POSITION_ID)) + ",";
      json += "\"symbol\":\"" + JsonEscape(symbol) + "\",";
      json += "\"type\":" + IntegerToString((int)type) + ",";
      json += "\"entry\":" + IntegerToString((int)HistoryDealGetInteger(ticket, DEAL_ENTRY)) + ",";
      json += "\"volume\":" + DoubleToString(HistoryDealGetDouble(ticket, DEAL_VOLUME), 2) + ",";
      json += "\"price\":" + DoubleToString(HistoryDealGetDouble(ticket, DEAL_PRICE), 5) + ",";
      json += "\"profit\":" + DoubleToString(HistoryDealGetDouble(ticket, DEAL_PROFIT), 2) + ",";
      json += "\"swap\":" + DoubleToString(HistoryDealGetDouble(ticket, DEAL_SWAP), 2) + ",";
      json += "\"commission\":" + DoubleToString(HistoryDealGetDouble(ticket, DEAL_COMMISSION), 2) + ",";
      json += "\"fee\":" + DoubleToString(HistoryDealGetDouble(ticket, DEAL_FEE), 2) + ",";
      json += "\"magic\":" + LongToString((long)HistoryDealGetInteger(ticket, DEAL_MAGIC)) + ",";
      json += "\"comment\":\"" + JsonEscape(HistoryDealGetString(ticket, DEAL_COMMENT)) + "\",";
      json += "\"time\":" + LongToString((long)HistoryDealGetInteger(ticket, DEAL_TIME));
      json += "}";
   }
   
   json += "],\"from\":" + LongToString((long)from) + ",\"to\":" + LongToString((long)to) + ",\"timestamp\":" + LongToString(TimeCurrent()) + "}";
   return json;
}

//+------------------------------------------------------------------+
//| Send String JSON to API                                          |
//+------------------------------------------------------------------+
bool SendJsonStr(string endpoint, string jsonStr)
{
   string url = InpApiBaseUrl + endpoint;
   map headers;
   headers["Authorization"] = "Bearer " + InpApiKey;
   headers["Content-Type"] = "application/json";
   headers["X-Account-ID"] = g_accountId;
   
   if(InpDebugLog) Print("POST ", endpoint, " (", StringLen(jsonStr), " bytes)");
   
   string response;
   int code = g_http.Post(url, headers, jsonStr, response);
   
   if(code == 200 || code == 201)
   {
      if(InpDebugLog) Print("  OK: ", response);
      return true;
   }
   else
   {
      Print("  ERROR HTTP ", code, ": ", response);
      return false;
   }
}

//+------------------------------------------------------------------+
//| Updated Push Functions using String JSON                         |
//+------------------------------------------------------------------+
void PushAccountInfo()
{
   SendJsonStr("/webhook/account", PushAccountInfoStr());
}

void PushPositions()
{
   SendJsonStr("/webhook/positions", PushPositionsStr());
}

void PushOrders()
{
   SendJsonStr("/webhook/orders", PushOrdersStr());
}

void PushHistory(int daysBack)
{
   SendJsonStr("/webhook/history", PushHistoryStr(daysBack));
}

//+------------------------------------------------------------------+
//| JSON Escape Helper                                               |
//+------------------------------------------------------------------+
string JsonEscape(string str)
{
   StringReplace(str, "\\", "\\\\");
   StringReplace(str, "\"", "\\\"");
   StringReplace(str, "\r", "\\r");
   StringReplace(str, "\n", "\\n");
   StringReplace(str, "\t", "\\t");
   return str;
}