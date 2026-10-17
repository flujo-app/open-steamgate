"! Repository workbench over the same STORE seam used by ADT and the editor.
"! This is a clean-room host transaction, not SAP-delivered Workbench source.
CLASS zcl_osd_workbench DEFINITION PUBLIC CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_http_extension.
    INTERFACES zif_osd_transaction.
    CONSTANTS c_path TYPE string VALUE `/sap/bc/osd/workbench/`.
    METHODS constructor IMPORTING iv_mode TYPE string DEFAULT `SE38`.
    CLASS-METHODS screen
      IMPORTING iv_mode TYPE string DEFAULT `SE38`
                iv_name TYPE string OPTIONAL iv_type TYPE string DEFAULT `PROG`
                iv_package TYPE string DEFAULT `$TMP` iv_filter TYPE string OPTIONAL
                iv_description TYPE string OPTIONAL iv_error TYPE string OPTIONAL
      RETURNING VALUE(rv_html) TYPE string.
    CLASS-METHODS execution_target IMPORTING iv_program TYPE string
      RETURNING VALUE(rv_url) TYPE string RAISING zcx_osd_adt.
  PRIVATE SECTION.
    DATA mv_mode TYPE string.
    DATA mo_container TYPE REF TO cl_gui_custom_container.
    DATA mo_viewer TYPE REF TO cl_gui_html_viewer.
    CLASS-METHODS esc IMPORTING iv_text TYPE clike RETURNING VALUE(rv_text) TYPE string.
    CLASS-METHODS component IMPORTING iv_text TYPE string RETURNING VALUE(rv_text) TYPE string.
    CLASS-METHODS edit_url IMPORTING iv_type TYPE string iv_name TYPE string
      iv_change TYPE abap_bool DEFAULT abap_false RETURNING VALUE(rv_url) TYPE string.
    CLASS-METHODS repository IMPORTING iv_mode TYPE string iv_package TYPE string
      iv_filter TYPE string RETURNING VALUE(rv_html) TYPE string
      RAISING zcx_osd_adt zcx_ajson_error.
    CLASS-METHODS package_link IMPORTING iv_package TYPE string iv_label TYPE string
      RETURNING VALUE(rv_html) TYPE string.
ENDCLASS.

CLASS zcl_osd_workbench IMPLEMENTATION.
  METHOD constructor.
    mv_mode = COND #( WHEN iv_mode = `SE80` THEN `SE80` ELSE `SE38` ).
  ENDMETHOD.
  METHOD esc.
    rv_text = cl_gui_control=>escape_html( iv_text ).
  ENDMETHOD.
  METHOD component.
    rv_text = zcl_osd_adt_uri=>encode_component( iv_text ).
  ENDMETHOD.
  METHOD edit_url.
    rv_url = |/sap/bc/osd/edit/?type={ component( iv_type ) }&name={ component( iv_name ) }|.
    IF iv_change = abap_true.
      rv_url = rv_url && `&change=x`.
    ENDIF.
  ENDMETHOD.
  METHOD execution_target.
    DATA ls_program TYPE zcl_osd_batch_report=>ty_program.
    DATA ls_object TYPE zcl_osd_adt_host=>ty_object.
    DATA lx_error TYPE REF TO zcx_osd_adt.
    ls_object = zcl_osd_adt_host=>object( iv_type = `PROG` iv_name = iv_program ).
    IF ls_object-found = abap_false.
      lx_error = zcx_osd_adt=>not_found( |Program { iv_program } does not exist.| ).
      RAISE EXCEPTION lx_error.
    ENDIF.
    IF ls_object-version <> `active`.
      lx_error = zcx_osd_adt=>conflict( `The program has inactive changes. Activate it before Execute.` ).
      RAISE EXCEPTION lx_error.
    ENDIF.
    ls_program = zcl_osd_batch_report=>dialog_program( iv_program ).
    IF ls_program-tcode IS INITIAL.
      lx_error = zcx_osd_adt=>not_supported( ls_program-reason ).
      RAISE EXCEPTION lx_error.
    ENDIF.
    rv_url = |/sap/bc/gui/sap/its/webgui/?okcode={ component( ls_program-tcode ) }|.
  ENDMETHOD.
  METHOD package_link.
    rv_html = |<a class="leaf" href="{ c_path }?mode=SE80&amp;package={ esc( component( iv_package ) ) }">| &&
      |<span class="lbl">{ esc( iv_label ) }</span><span class="tech">{ esc( iv_package ) }</span></a>|.
  ENDMETHOD.
  METHOD repository.
    DATA lo_input TYPE REF TO zcl_osd_adt_json.
    DATA ls_answer TYPE zcl_osd_adt_host=>ty_answer.
    DATA lo_json TYPE REF TO zcl_ajson.
    DATA lt_members TYPE string_table.
    DATA lv_member TYPE string.
    DATA lv_path TYPE string.
    DATA lv_name TYPE string.
    DATA lv_type TYPE string.
    DATA lv_parent TYPE string.
    DATA lv_last_type TYPE string.
    DATA lt_lines TYPE string_table.
    DATA lv_line TYPE string.
    DATA lv_library TYPE string.
    CREATE OBJECT lo_input.
    IF iv_mode = `SE80` AND iv_filter IS INITIAL.
      IF iv_package IS INITIAL.
        ls_answer = zcl_osd_adt_host=>store( iv_command = `PACKAGES` iv_json = `{}` ).
        lo_json = zcl_ajson=>parse( ls_answer-json ).
        lt_members = zcl_osd_adt_json=>ordered_members( io_json = lo_json iv_path = `/` ).
        rv_html = `<div class="tree" data-workbench="SE80"><details open><summary>Packages</summary><div class="kids">`.
        LOOP AT lt_members INTO lv_member.
          lv_path = `/` && lv_member.
          lv_parent = lo_json->get_string( lv_path && `/parent` ).
          IF lv_parent IS NOT INITIAL.
            CONTINUE.
          ENDIF.
          lv_name = lo_json->get_string( lv_path && `/name` ).
          rv_html = rv_html && package_link( iv_package = lv_name iv_label = lo_json->get_string( lv_path && `/description` ) ).
        ENDLOOP.
        rv_html = rv_html && `</div></details></div>`.
        RETURN.
      ENDIF.
      lo_input->add( iv_name = `name` iv_value = iv_package ).
      lo_input->add( iv_name = `mode` iv_value = `raw` ).
      ls_answer = zcl_osd_adt_host=>store( iv_command = `PACKAGE` iv_json = lo_input->document( ) ).
      lo_json = zcl_ajson=>parse( ls_answer-json ).
      rv_html = |<div class="tree" data-workbench="SE80"><details open><summary>{ esc( iv_package ) }</summary><div class="kids">|.
      rv_html = rv_html && package_link( iv_package = `` iv_label = `All packages` ).
      lv_parent = lo_json->get_string( `/parent` ).
      IF lv_parent IS NOT INITIAL.
        rv_html = rv_html && package_link( iv_package = lv_parent iv_label = `Parent package` ).
      ENDIF.
      lt_members = zcl_osd_adt_json=>ordered_members( io_json = lo_json iv_path = `/subpackages` ).
      LOOP AT lt_members INTO lv_member.
        lv_path = `/subpackages/` && lv_member.
        rv_html = rv_html && package_link( iv_package = lo_json->get_string( lv_path && `/name` )
          iv_label = lo_json->get_string( lv_path && `/description` ) ).
      ENDLOOP.
      lt_members = zcl_osd_adt_json=>ordered_members( io_json = lo_json iv_path = `/objects` ).
      LOOP AT lt_members INTO lv_member.
        lv_path = `/objects/` && lv_member.
        lv_name = lo_json->get_string( lv_path && `/name` ).
        lv_type = lo_json->get_string( lv_path && `/type` ).
        IF lv_type <> lv_last_type.
          IF lv_last_type IS NOT INITIAL.
            rv_html = rv_html && `</div></details>`.
          ENDIF.
          rv_html = rv_html && |<details open><summary>{ esc( lv_type ) }</summary><div class="kids">|.
          lv_last_type = lv_type.
        ENDIF.
        rv_html = rv_html && |<a class="leaf" href="{ esc( edit_url( iv_type = lv_type iv_name = lv_name ) ) }">| &&
          |<span class="lbl">{ esc( lv_name ) }</span><span class="tech">{ esc( lv_type ) }</span></a>|.
      ENDLOOP.
      IF lv_last_type IS NOT INITIAL.
        rv_html = rv_html && `</div></details>`.
      ENDIF.
      rv_html = rv_html && `</div></details></div>`.
    ELSE.
      lo_input->add( iv_name = `seed` iv_value = iv_filter ).
      lo_input->add( iv_name = `format` iv_value = `lines` ).
      lo_input->add_raw( iv_name = `limit` iv_json = `100` ).
      IF iv_mode <> `SE80`.
        lo_input->add( iv_name = `type` iv_value = `PROG` ).
      ENDIF.
      ls_answer = zcl_osd_adt_host=>store( iv_command = `SEARCH` iv_json = lo_input->document( ) ).
      SPLIT ls_answer-source AT cl_abap_char_utilities=>newline INTO TABLE lt_lines.
      rv_html = `<p>Up to 100 matching objects. Choose one to display its source.</p><div class="tree" data-workbench="SE80">`.
      LOOP AT lt_lines INTO lv_line WHERE table_line IS NOT INITIAL.
        SPLIT lv_line AT cl_abap_char_utilities=>horizontal_tab INTO lv_type lv_name lv_library.
        rv_html = rv_html && |<a class="leaf" href="{ esc( edit_url( iv_type = lv_type iv_name = lv_name ) ) }">| &&
          |<span class="lbl">{ esc( lv_name ) }</span><span class="tech">{ esc( lv_type ) }</span></a>|.
      ENDLOOP.
      rv_html = rv_html && `</div>`.
    ENDIF.
  ENDMETHOD.
  METHOD screen.
    DATA lv_title TYPE string.
    DATA lv_body TYPE string.
    DATA lv_type TYPE string.
    DATA lx_error TYPE REF TO cx_root.
    lv_title = COND #( WHEN iv_mode = `SE80` THEN `Steamgate Object Navigator - SE80` ELSE `Steamgate ABAP Editor - SE38` ).
    lv_type = COND #( WHEN iv_mode = `SE80` THEN iv_type ELSE `PROG` ).
    lv_body = |<h2>{ esc( lv_title ) }</h2>|.
    IF iv_error IS NOT INITIAL.
      lv_body = lv_body && |<p class="err">{ esc( iv_error ) }</p>|.
    ENDIF.
    lv_body = lv_body && |<form method="post" action="{ c_path }">| &&
      |<input type="hidden" name="mode" value="{ esc( iv_mode ) }">|.
    IF iv_mode = `SE80`.
      lv_body = lv_body && |<label for="type">Object type</label><input id="type" name="type" value="{ esc( lv_type ) }" maxlength="4">|.
    ELSE.
      lv_body = lv_body && `<input type="hidden" name="type" value="PROG">`.
    ENDIF.
    lv_body = lv_body && |<label for="name">{ COND string( WHEN iv_mode = `SE80` THEN `Object` ELSE `Program` ) }</label>| &&
      |<input id="name" name="name" value="{ esc( iv_name ) }" maxlength="40">| &&
      `<div class="bar"><button name="do" value="display">Display</button><button name="do" value="change">Change</button>` &&
      `<button name="do" value="execute">Execute</button><button name="do" value="create">Create program</button></div>` &&
      |<label for="package">Package</label><input id="package" name="package" value="{ esc( iv_package ) }" maxlength="64">| &&
      |<label for="description">New program title</label><input id="description" name="description" value="{ esc( iv_description ) }" maxlength="64">| &&
      |<label for="q">Object filter</label><input id="q" name="q" value="{ esc( iv_filter ) }" maxlength="64">| &&
      `<button name="do" value="find">Find</button></form>` &&
      `<p>Execute runs the active program. Save and Activate are available in Change.</p>`.
    TRY.
        lv_body = lv_body && repository( iv_mode = iv_mode iv_package = iv_package iv_filter = iv_filter ).
      CATCH cx_root INTO lx_error.
        lv_body = lv_body && |<p class="err">{ esc( lx_error->get_text( ) ) }</p>|.
    ENDTRY.
    rv_html = |<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{ esc( lv_title ) }</title>| &&
      `<style>body{font:14px system-ui;margin:20px;color:#18334e;background:#eef3f9}` &&
      `label{display:block;margin-top:8px}input{padding:5px;max-width:95%}.bar{margin:12px 0}` &&
      `button{margin-right:8px;padding:5px 12px}.tree{margin-top:20px}.kids{padding-left:18px}` &&
      `.leaf{display:block;padding:4px;color:#0a6ed1}.tech{margin-left:12px;color:#52677b}` &&
      `.err{border-left:4px solid #b03030;padding:10px;background:#fff0f0}</style></head><body>` && lv_body && `</body></html>`.
  ENDMETHOD.
  METHOD if_http_extension~handle_request.
    DATA lt_fields TYPE tihttpnvp.
    DATA lv_mode TYPE string.
    DATA lv_name TYPE string.
    DATA lv_type TYPE string.
    DATA lv_package TYPE string.
    DATA lv_filter TYPE string.
    DATA lv_description TYPE string.
    DATA lv_action TYPE string.
    DATA lv_url TYPE string.
    DATA lv_error TYPE string.
    DATA lo_input TYPE REF TO zcl_osd_adt_json.
    DATA ls_answer TYPE zcl_osd_adt_host=>ty_answer.
    DATA lx_error TYPE REF TO cx_root.
    DATA lx_request TYPE REF TO zcx_osd_adt.
    lt_fields = zcl_osd_form=>fields( server->request ).
    lv_mode = zcl_osd_form=>value( it_fields = lt_fields iv_name = `mode` ).
    lv_mode = COND #( WHEN lv_mode = `SE80` THEN `SE80` ELSE `SE38` ).
    lv_name = to_upper( zcl_osd_form=>value( it_fields = lt_fields iv_name = `name` ) ).
    lv_type = to_upper( zcl_osd_form=>value( it_fields = lt_fields iv_name = `type` ) ).
    IF lv_type IS INITIAL OR lv_mode = `SE38`.
      lv_type = `PROG`.
    ENDIF.
    lv_package = to_upper( zcl_osd_form=>value( it_fields = lt_fields iv_name = `package` ) ).
    lv_filter = zcl_osd_form=>value( it_fields = lt_fields iv_name = `q` ).
    lv_description = zcl_osd_form=>value( it_fields = lt_fields iv_name = `description` ).
    lv_action = zcl_osd_form=>value( it_fields = lt_fields iv_name = `do` ).
    TRY.
        IF lv_action IS NOT INITIAL AND lv_action <> `find` AND lv_name IS INITIAL.
          lx_request = zcx_osd_adt=>invalid_request( `Enter an object or program name.` ).
          RAISE EXCEPTION lx_request.
        ENDIF.
        IF lv_action = `create` OR lv_action = `execute`.
          IF server->request->get_method( ) <> `POST`.
            lx_request = zcx_osd_adt=>invalid_request( `Use the form button for this action.` ).
            RAISE EXCEPTION lx_request.
          ENDIF.
          IF lv_type <> `PROG`.
            lx_request = zcx_osd_adt=>invalid_request( `Create program and Execute require object type PROG.` ).
            RAISE EXCEPTION lx_request.
          ENDIF.
        ENDIF.
        CASE lv_action.
          WHEN `display` OR `change`.
            lv_url = edit_url( iv_type = lv_type iv_name = lv_name iv_change = boolc( lv_action = `change` ) ).
          WHEN `execute`.
            lv_url = execution_target( lv_name ).
          WHEN `create`.
            CREATE OBJECT lo_input.
            lo_input->add( iv_name = `package` iv_value = COND #( WHEN lv_package IS INITIAL THEN `$TMP` ELSE lv_package ) ).
            lo_input->add( iv_name = `description` iv_value = lv_description ).
            zcl_osd_adt_host=>require( `CREATE` ).
            ls_answer = zcl_osd_adt_host=>store( iv_command = `CREATE` iv_type = `PROG`
              iv_name = lv_name iv_json = lo_input->document( )
              iv_source = |REPORT { to_lower( lv_name ) }.{ cl_abap_char_utilities=>newline }| ).
            lv_url = edit_url( iv_type = `PROG` iv_name = lv_name iv_change = abap_true ).
        ENDCASE.
      CATCH cx_root INTO lx_error.
        lv_error = lx_error->get_text( ).
    ENDTRY.
    IF lv_url IS NOT INITIAL AND lv_error IS INITIAL.
      server->response->set_status( code = 303 reason = `See Other` ).
      server->response->set_header_field( name = `location` value = lv_url ).
      RETURN.
    ENDIF.
    server->response->set_header_field( name = `content-type` value = `text/html; charset=utf-8` ).
    server->response->set_cdata( screen( iv_mode = lv_mode iv_name = lv_name iv_type = lv_type
      iv_package = lv_package iv_filter = lv_filter iv_description = lv_description iv_error = lv_error ) ).
  ENDMETHOD.
  METHOD zif_osd_transaction~roll_in.
    IF iv_state = `SE38` OR iv_state = `SE80`.
      mv_mode = iv_state.
    ENDIF.
  ENDMETHOD.
  METHOD zif_osd_transaction~roll_out.
    rv_state = mv_mode.
  ENDMETHOD.
  METHOD zif_osd_transaction~title.
    rv_title = COND #( WHEN mv_mode = `SE80` THEN `Object Navigator` ELSE `ABAP Editor` ).
  ENDMETHOD.
  METHOD zif_osd_transaction~message.
    rv_message = `Choose an object or enter a program.`.
  ENDMETHOD.
  METHOD zif_osd_transaction~pbo.
    DATA lt_html TYPE STANDARD TABLE OF string WITH DEFAULT KEY.
    DATA lv_html TYPE string.
    DATA lv_url TYPE c LENGTH 255.
    CREATE OBJECT mo_container EXPORTING container_name = 'OSD_WORKBENCH'.
    CREATE OBJECT mo_viewer EXPORTING parent = mo_container.
    lv_html = screen( iv_mode = mv_mode ).
    APPEND lv_html TO lt_html.
    mo_viewer->load_data( EXPORTING type = 'text' subtype = 'html' size = strlen( lv_html )
      IMPORTING assigned_url = lv_url CHANGING data_table = lt_html EXCEPTIONS OTHERS = 1 ).
    IF sy-subrc = 0.
      mo_viewer->show_url( EXPORTING url = lv_url EXCEPTIONS OTHERS = 1 ).
    ENDIF.
  ENDMETHOD.
ENDCLASS.
