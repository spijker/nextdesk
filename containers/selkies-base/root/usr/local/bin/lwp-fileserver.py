#!/usr/bin/env python3
"""
Simple HTTP server for local filesystem access.
Exposes mounted drives and local files to the backend API.
Runs on port 19090 inside the container.
"""
import json
import os
import subprocess
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs
import mimetypes

class FileServerHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Suppress default logging
        pass
    
    def do_GET(self):
        path = urlparse(self.path)
        
        if path.path == "/api/files":
            self.handle_list_files(path.query)
        elif path.path.startswith("/api/files/"):
            self.handle_file_operation(path.path[len("/api/files/"):], path.query)
        else:
            self.send_error(404, "Not found")
    
    def do_POST(self):
        path = urlparse(self.path)
        
        if path.path == "/api/files/mkdir":
            self.handle_mkdir(path.query)
        elif path.path == "/api/files/upload":
            self.handle_upload(path.query)
        else:
            self.send_error(404, "Not found")
    
    def do_DELETE(self):
        path = urlparse(self.path)
        
        if path.path == "/api/files/delete":
            self.handle_delete(path.query)
        else:
            self.send_error(404, "Not found")
    
    def handle_list_files(self, query):
        """List files in a directory"""
        params = parse_qs(query)
        dir_path = params.get('path', ['/'])[0]
        
        try:
            if not os.path.exists(dir_path):
                self.send_error(404, "Path not found")
                return
            
            if not os.path.isdir(dir_path):
                self.send_error(400, "Path is not a directory")
                return
            
            items = []
            for entry in os.scandir(dir_path):
                item = {
                    "name": entry.name,
                    "path": os.path.join(dir_path, entry.name) if dir_path != '/' else f"/{entry.name}",
                    "type": "dir" if entry.is_dir() else "file",
                    "size": entry.stat().st_size if entry.is_file() else 0,
                    "modified": str(entry.stat().st_mtime),
                    "mime": mimetypes.guess_type(entry.name)[0] if entry.is_file() else ""
                }
                items.append(item)
            
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(items).encode())
            
        except Exception as e:
            self.send_error(500, str(e))
    
    def handle_file_operation(self, subpath, query):
        """Handle file operations (download, thumbnail, etc.)"""
        params = parse_qs(query)
        file_path = params.get('path', [''])[0]
        
        if subpath == "download":
            self.handle_download(file_path)
        elif subpath == "thumbnail":
            self.handle_thumbnail(file_path, params)
        else:
            self.send_error(404, "Not found")
    
    def handle_mkdir(self, query):
        """Create a directory"""
        params = parse_qs(query)
        dir_path = params.get('path', [''])[0]
        
        try:
            if os.path.exists(dir_path):
                self.send_error(400, "Path already exists")
                return
            
            os.makedirs(dir_path)
            self.send_response(201)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True}).encode())
            
        except Exception as e:
            self.send_error(500, str(e))
    
    def handle_upload(self, query):
        """Upload a file"""
        params = parse_qs(query)
        dir_path = params.get('path', ['/'])[0]
        
        try:
            # Read content length
            content_length = int(self.headers.get('Content-Length', 0))
            
            # Get filename from Content-Disposition header
            content_disposition = self.headers.get('Content-Disposition', '')
            filename = 'upload'
            if 'filename=' in content_disposition:
                filename = content_disposition.split('filename=')[1].split(';')[0].strip('"')
            
            # Ensure directory exists
            if not os.path.exists(dir_path):
                os.makedirs(dir_path)
            
            # Write file
            file_path = os.path.join(dir_path, filename)
            with open(file_path, 'wb') as f:
                f.write(self.rfile.read(content_length))
            
            self.send_response(201)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True, "path": file_path}).encode())
            
        except Exception as e:
            self.send_error(500, str(e))
    
    def handle_delete(self, query):
        """Delete a file or directory"""
        params = parse_qs(query)
        file_path = params.get('path', [''])[0]
        
        try:
            if not os.path.exists(file_path):
                self.send_error(404, "Path not found")
                return
            
            if os.path.isdir(file_path):
                import shutil
                shutil.rmtree(file_path)
            else:
                os.remove(file_path)
            
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True}).encode())
            
        except Exception as e:
            self.send_error(500, str(e))
    
    def handle_download(self, file_path):
        """Download a file"""
        try:
            if not os.path.exists(file_path):
                self.send_error(404, "File not found")
                return
            
            if not os.path.isfile(file_path):
                self.send_error(400, "Path is not a file")
                return
            
            mime_type = mimetypes.guess_type(file_path)[0] or 'application/octet-stream'
            
            self.send_response(200)
            self.send_header('Content-Type', mime_type)
            self.send_header('Content-Disposition', f'attachment; filename="{os.path.basename(file_path)}"')
            self.end_headers()
            
            with open(file_path, 'rb') as f:
                self.wfile.write(f.read())
                
        except Exception as e:
            self.send_error(500, str(e))
    
    def handle_thumbnail(self, file_path, params):
        """Generate thumbnail for image files"""
        try:
            if not os.path.exists(file_path):
                self.send_error(404, "File not found")
                return
            
            if not os.path.isfile(file_path):
                self.send_error(400, "Path is not a file")
                return
            
            # For now, just return a simple icon
            # In a real implementation, we'd use PIL or similar to generate thumbnails
            self.send_response(200)
            self.send_header('Content-Type', 'image/png')
            self.end_headers()
            # Return a simple placeholder
            self.wfile.write(b'\x89PNG\r\n\x1a\n...')
            
        except Exception as e:
            self.send_error(500, str(e))

def run():
    """Run the file server"""
    server_address = ('0.0.0.0', 19090)
    httpd = HTTPServer(server_address, FileServerHandler)
    
    # Log to stderr
    print(f"lwp-fileserver: listening on {server_address[0]}:{server_address[1]}", file=__import__('sys').stderr)
    
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()

if __name__ == '__main__':
    run()