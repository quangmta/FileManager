"""Auth API routes."""
import app as core
from app import *

@app.get('/')
def index():return app.send_static_file('index.html')
@app.get('/api/session')
def session_info():
    if not session.get('username'):return jsonify(authenticated=False)
    with dbconn() as d:u=d.execute('SELECT username,role FROM users WHERE username=?',(session['username'],)).fetchone()
    if not u:session.clear();return jsonify(authenticated=False)
    return jsonify(authenticated=True,username=u['username'],role=u['role'],csrf=session['csrf'],root=str(core.ROOT),idle_timeout=MAX_SESSION_IDLE,max_upload=MAX_UPLOAD)
@app.post('/api/login')
def login():
    x=request.get_json(silent=True) or {}
    with dbconn() as d:u=d.execute('SELECT * FROM users WHERE username=?',(str(x.get('username','')),)).fetchone()
    if not u or not check_password_hash(u['password_hash'],str(x.get('password',''))):
        time.sleep(.25);audit('login_failed',detail='Sai thông tin đăng nhập');return jsonify(error='Tên đăng nhập hoặc mật khẩu không đúng.'),401
    now=time.time();session_key=secrets.token_urlsafe(32)
    with dbconn() as d:
        d.execute('DELETE FROM sessions WHERE last_activity<?',(now-MAX_SESSION_IDLE,))
        d.execute('INSERT INTO sessions(session_key,username,created_at,last_activity,ip,user_agent) VALUES(?,?,?,?,?,?)',(session_key,u['username'],now,now,request.remote_addr or '',request.user_agent.string[:300]))
    session.clear();session['username']=u['username'];session['csrf']=secrets.token_urlsafe(32);session['session_key']=session_key;audit('login',detail='Đăng nhập thành công')
    return jsonify(authenticated=True,username=u['username'],role=u['role'],csrf=session['csrf'],root=str(core.ROOT))
@app.post('/api/logout')
@require()
@csrf
def logout():
    audit('logout')
    with dbconn() as d:d.execute('DELETE FROM sessions WHERE session_key=?',(session.get('session_key'),))
    session.clear();return jsonify(ok=True)
